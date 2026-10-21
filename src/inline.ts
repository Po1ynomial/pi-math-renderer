/**
 * Inline math: one-row images inside a line of text.
 *
 * pi writes any line containing a kitty escape verbatim — it never wraps or pads
 * such a line — so this pass owns the line layout: it finds inline spans with
 * pi's own delimiter rules, places an image for each, advances the cursor over
 * it with spaces, and re-flows the paragraph so no emitted line exceeds the
 * available width.
 *
 * A table row is laid out by pi's table renderer instead, down to the width of
 * every cell, so a row is written as a single line with the placement's advance
 * spaces marked, and only while the table still fits: see `renderTableBlock`.
 *
 * The image itself is placed at the cursor with `r=1` and the formula is
 * clipped to a single cell (see `snapWrap`), so what is shown is the formula cut
 * at the cell edges, never scaled down.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { allocateImageId, carriesPlacement, displayCommand, RESET_ESCAPE } from "./kitty.ts";
import type { FormulaPlacements, FormulaRequest, PlacedFormula } from "./render.ts";
import { type LineRecord, lineContent, scanLines, splitTableCells } from "./structure.ts";
import { beginsDisplayMath } from "./transform.ts";

/** One inline math span inside a line. */
export interface InlineSpan {
  /** Offset of the opening delimiter. */
  start: number;
  /** Offset just past the closing delimiter. */
  end: number;
  /** LaTeX source without delimiters. */
  latex: string;
}

/**
 * pi's escape test: a delimiter preceded by an odd number of backslashes is
 * escaped, so `\$` does not open or close math.
 */
function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function findClosing(source: string, closing: string, from: number): number {
  let index = source.indexOf(closing, from);
  while (index >= 0 && isEscaped(source, index)) {
    index = source.indexOf(closing, index + closing.length);
  }
  return index;
}

/**
 * Inline math spans in one line, using the same rules as pi's own tokenizer
 * (`tokenizeInlineLatex` in pi-tui): `$…$`, `\(…\)` and `\[…\]` mid-text, with
 * the `$` guards that keep prices, `A_B` identifiers and code spans out, and no
 * span crossing a line break.
 */
export function findInlineSpans(line: string): InlineSpan[] {
  const code: { start: number; end: number }[] = [];
  for (const match of line.matchAll(/`+[^`]*`+/g)) {
    code.push({ start: match.index, end: match.index + match[0].length });
  }
  const inCode = (offset: number): boolean =>
    code.some((range) => offset >= range.start && offset < range.end);

  const spans: InlineSpan[] = [];
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character !== "$" && character !== "\\") continue;
    if (isEscaped(line, index) || inCode(index)) continue;

    let opening: string;
    let closing: string;
    if (line.startsWith("\\(", index)) {
      opening = "\\(";
      closing = "\\)";
    } else if (line.startsWith("\\[", index)) {
      opening = "\\[";
      closing = "\\]";
    } else if (character === "$" && line[index + 1] !== "$" && !/^\$\s/.test(line.slice(index))) {
      opening = "$";
      closing = "$";
    } else {
      continue;
    }

    const close = findClosing(line, closing, index + opening.length);
    if (close < 0) continue;
    const body = line.slice(index + opening.length, close);
    if (!body || body.includes("\n")) continue;
    if (opening === "$") {
      const after = line.slice(close + 1);
      // pi's guards: no trailing space, no "$x$5" prices, no A_B_C identifiers,
      // no code spans inside the body.
      if (/\s$/.test(body)) continue;
      if (/^\d/.test(after)) continue;
      if (/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(body) && /^[A-Za-z_][A-Za-z0-9_]*/.test(after)) continue;
      if (body.includes("`")) continue;
    }
    spans.push({ start: index, end: close + closing.length, latex: body });
    index = close + closing.length - 1;
  }
  return spans;
}

/** Text runs and image atoms, in source order. */
type Token =
  | { kind: "text"; text: string; width: number }
  | { kind: "image"; text: string; width: number };

/** Offsets of the pipes that separate table cells on a line. */
function unescapedPipes(line: string): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "|" && !isEscaped(line, index)) offsets.push(index);
  }
  return offsets;
}

/**
 * The inline spans of one line.
 *
 * On a table row the spans are searched per cell, which is how pi lexes the
 * line: a pipe ends a cell, so a `$` that opens in one cell and closes in the
 * next is not math to pi, and must not become an image here.
 */
function inlineSpans(record: LineRecord): InlineSpan[] {
  const spans = findInlineSpans(record.text);
  if (record.table === undefined) return spans;
  const pipes = unescapedPipes(record.text);
  return spans.filter((span) => !pipes.some((offset) => offset > span.start && offset < span.end));
}

/**
 * One placement written into a line: the command, the so-far blank cells that
 * advance the cursor over the image, and a marker for the spaces.
 *
 * pi draws the image where the cursor already is and never moves it itself
 * (`C=1`), so the spaces are what reserve the cells the image covers. In a table
 * cell they also have to survive markdown: the parser trims a cell's trailing
 * whitespace, so a cell's placement is followed by {@link RESET_ESCAPE} to keep
 * the run of spaces off the end of the cell.
 */
function placementText(placement: PlacedFormula, marker: string): string {
  const { cols } = placement;
  return displayCommand(placement.path, allocateImageId(), cols, 1) + " ".repeat(cols) + marker;
}

function textTokens(text: string): Token[] {
  return text
    .split(/(\s+)/)
    .filter((piece) => piece !== "")
    .map((piece) => ({ kind: "text" as const, text: piece, width: piece.length }));
}

/**
 * Break a line into rows that each fit `availableCols`.
 *
 * An image is an unbreakable run of `cols` cells, exactly as it is in the
 * terminal: a row never ends inside one. Returns `undefined` when the line
 * cannot be laid out — an image wider than the whole line, or a word that
 * cannot fit — in which case the caller keeps the source text.
 */
function wrapTokens(tokens: Token[], limit: number): { text: string; width: number }[] | undefined {
  if (limit < 1) return undefined;
  const rows: { text: string; width: number }[] = [];
  let current = "";
  let width = 0;
  const flush = (): void => {
    const trailing = /[ \t]+$/.exec(current)?.[0].length ?? 0;
    rows.push({ text: current.replace(/[ \t]+$/, ""), width: Math.max(0, width - trailing) });
    current = "";
    width = 0;
  };
  for (const token of tokens) {
    if (token.kind === "image" && token.width > limit) return undefined;
    if (width + token.width > limit && current !== "") {
      // Never break inside an image; a space before it is dropped with the row.
      if (token.kind === "image" || !/^\s+$/.test(token.text)) {
        flush();
      } else {
        current += token.text;
        width += token.width;
        continue;
      }
    }
    current += token.text;
    width += token.width;
  }
  if (current !== "") flush();
  return rows;
}

/** One-line replacement for a line, or `undefined` to keep the source. */
function renderLine(
  record: LineRecord,
  spans: InlineSpan[],
  placed: (PlacedFormula | undefined)[],
  availableCols: number,
  log: (message: string) => void,
): string | undefined {
  const { text: line, structure } = record;

  let cursor = structure.prefix.length;
  const tokens: Token[] = [];
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index] as InlineSpan;
    const placement = placed[index];
    if (!placement) {
      log(`inline: no placement for ${JSON.stringify(span.latex.slice(0, 40))}`);
      return undefined;
    }
    const before = line.slice(cursor, span.start);
    const { cols } = placement;
    tokens.push(...textTokens(before), {
      kind: "image",
      text: placementText(placement, ""),
      width: cols,
    });
    cursor = span.end;
  }
  tokens.push(...textTokens(line.slice(cursor)));

  const limit = availableCols - Math.max(structure.firstCols, structure.continuationCols);
  const rows = wrapTokens(tokens, limit);
  if (!rows || rows.length === 0) return undefined;
  if (rows.some((row) => row.width > limit)) return undefined;
  // Rows carrying an image are written verbatim by pi; the others get the same
  // block structure the source line had, so quotes and lists stay intact.
  return rows
    .map((row, index) => (index === 0 ? structure.prefix : structure.continuation) + row.text)
    .join("\n");
}

/** One line's math, with the placements the renderer answered for it. */
interface LineWork {
  record: LineRecord;
  spans: InlineSpan[];
  placed: (PlacedFormula | undefined)[];
}

/**
 * Maximal runs of consecutive lines that belong to one table.
 *
 * A table is one unit of decision because pi sizes its columns across all of
 * its rows: one placement too wide makes the renderer shrink the table, and a
 * shrunk column wraps its cell.
 */
function tableBlocks(records: LineRecord[]): LineRecord[][] {
  const blocks: LineRecord[][] = [];
  let index = 0;
  while (index < records.length) {
    if ((records[index] as LineRecord).table === undefined) {
      index += 1;
      continue;
    }
    const block: LineRecord[] = [];
    while (index < records.length && (records[index] as LineRecord).table !== undefined) {
      block.push(records[index] as LineRecord);
      index += 1;
    }
    blocks.push(block);
  }
  return blocks;
}

/**
 * Whether a table still fits once its formulas are placements.
 *
 * pi sizes each column from the widest thing in it and fills every cell out to
 * that width. It shrinks a table only when the columns' natural widths exceed
 * the available width, and shrinking wraps cells, so this has to know the
 * answer before it places anything.
 *
 * The estimate takes each column's widest cell as the line will be written,
 * with the markdown syntax a cell still carries counted at full width. pi's
 * inline renderer strips that syntax, so the estimate can only over-count, and
 * a table it accepts cannot be shrunk.
 */
function tableFits(rows: string[], availableCols: number): boolean {
  if (availableCols < 1) return false;
  const cells = rows.map(splitTableCells);
  const columns = cells[0]?.length ?? 0;
  if (columns === 0) return false;
  // pi's border overhead: "| " + (columns - 1) * " | " + " |".
  let total = 3 * columns + 1;
  for (let column = 0; column < columns; column += 1) {
    let widest = 0;
    for (const row of cells) {
      widest = Math.max(widest, visibleWidth((row[column] ?? "").replace(/\t/g, "   ")));
    }
    total += widest;
  }
  return total <= availableCols;
}

/** The line as a single row, with each span replaced by its placement. */
function splicePlacements(
  item: LineWork,
  marker: string,
  log: (message: string) => void,
): string | undefined {
  const { record, spans, placed } = item;
  const { text: line, structure } = record;
  let cursor = structure.prefix.length;
  let out = structure.prefix;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index] as InlineSpan;
    const placement = placed[index];
    if (placement === undefined) {
      log(`inline: no placement for ${JSON.stringify(span.latex.slice(0, 40))}`);
      return undefined;
    }
    out += line.slice(cursor, span.start) + placementText(placement, marker);
    cursor = span.end;
  }
  return out + line.slice(cursor);
}

/**
 * Replace the math in one table, or leave the whole table as it was.
 *
 * A table row cannot be re-flowed: the parser reads a line break anywhere in a
 * row as another row, so a split row comes back as a table with the wrong
 * columns and its text in the wrong cells. A row is therefore written on one
 * line, exactly as it arrived, and a table whose rows would no longer fit the
 * width keeps its LaTeX, which hands the whole table back to pi's Unicode
 * typesetting.
 */
function renderTableBlock(
  block: LineRecord[],
  work: Map<number, LineWork>,
  availableCols: number,
  replacements: Map<number, string>,
  log: (message: string) => void,
): number {
  const rows: string[] = [];
  const replaced: [number, string][] = [];
  for (const record of block) {
    // The delimiter row is drawn by the table renderer, not written by us.
    if (record.table === "delimiter") continue;
    const item = work.get(record.index);
    const line = item === undefined ? undefined : splicePlacements(item, RESET_ESCAPE, log);
    if (line === undefined) {
      rows.push(lineContent(record));
      continue;
    }
    replaced.push([record.index, line]);
    rows.push(line.slice(record.structure.prefix.length));
  }
  if (replaced.length === 0) return 0;

  const indent = Math.max(
    ...block.map((record) => Math.max(record.structure.firstCols, record.structure.continuationCols)),
  );
  const width = availableCols - indent;
  if (!tableFits(rows, width)) {
    log(`inline table rows=${rows.length} kept as text: the placements do not fit ${width} columns`);
    return 0;
  }
  for (const [index, line] of replaced) replacements.set(index, line);
  return replaced.length;
}

/**
 * Replace the inline math in a message with one-row images.
 *
 * Lines the pass leaves alone: fenced code, lines that already carry a
 * placement, the delimiters of a display-math block (which belong to the
 * display pass, rendered or not), indented code, and any line whose layout
 * cannot be made to fit. A table is a unit of its own: its rows are written one
 * line each and only while the table still fits, because pi, not this pass,
 * lays a table out.
 */
export function renderInlineMath(
  markdown: string,
  availableCols: number,
  renderer: FormulaPlacements,
  log: (message: string) => void = () => {},
): string {
  const records = scanLines(markdown);
  const work: LineWork[] = [];

  for (const record of records) {
    if (record.fence) continue;
    if (carriesPlacement(record.text)) continue;
    // A display-math block belongs to the display pass even when its render
    // failed and its source is still in the message: its delimiters are not
    // inline math.
    if (beginsDisplayMath(record.text)) continue;
    // An indented code block is not a paragraph: leave its contents alone, and
    // do not render formulas that would only be thrown away.
    if (record.structure.indented) continue;
    const { text } = record;
    if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) continue;
    const spans = inlineSpans(record);
    if (spans.length > 0) work.push({ record, spans, placed: [] });
  }
  if (work.length === 0) return markdown;

  // One call for the whole message: the renderer batches what is missing, and
  // repeated formulas come back as one placement per occurrence.
  const requests: FormulaRequest[] = [];
  for (const item of work) {
    for (const span of item.spans) requests.push({ latex: span.latex, display: "inline" });
  }
  const placed = renderer.placements(requests);

  // Hand each line the slice of placements that belongs to it.
  let cursor = 0;
  for (const item of work) {
    item.placed = item.spans.map(() => placed[cursor++] as PlacedFormula | undefined);
  }

  const replacements = new Map<number, string>();
  const byIndex = new Map(work.map((item) => [item.record.index, item]));

  // Tables first: whether a table can carry images is a decision about the
  // whole table, and it depends on how every one of its rows will be written.
  let tableLines = 0;
  for (const block of tableBlocks(records)) {
    tableLines += renderTableBlock(block, byIndex, availableCols, replacements, log);
  }

  let emitted = 0;
  for (const item of work) {
    if (item.record.table !== undefined) continue;
    const replacement = renderLine(item.record, item.spans, item.placed, availableCols, log);
    if (replacement === undefined) continue;
    replacements.set(item.record.index, replacement);
    emitted += 1;
  }
  log(`inline lines=${work.length} replaced=${emitted + tableLines} tableLines=${tableLines}`);
  return records.map((record) => replacements.get(record.index) ?? record.text).join("\n");
}

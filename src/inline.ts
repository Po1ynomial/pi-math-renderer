/**
 * Inline math: one-row images inside a line of text.
 *
 * pi writes any line containing a kitty escape verbatim — it never wraps or pads
 * such a line — so this pass owns the line layout: it finds inline spans with
 * pi's own delimiter rules, places an image for each, advances the cursor over
 * it with spaces, and re-flows the paragraph so no emitted line exceeds the
 * available width.
 *
 * The image itself is placed at the cursor with `r=1` and the formula is
 * clipped to a single cell (see `snapWrap`), so what is shown is the formula cut
 * at the cell edges, never scaled down.
 */

import { allocateImageId, carriesPlacement, displayCommand } from "./kitty.ts";
import type { FormulaPlacements, FormulaRequest, PlacedFormula } from "./render.ts";
import { type LineRecord, scanLines } from "./structure.ts";
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
    const command = displayCommand(placement.path, allocateImageId(), cols, 1);
    tokens.push(...textTokens(before), {
      kind: "image",
      text: `${command}${" ".repeat(cols)}`,
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

/**
 * Replace the inline math in a message with one-row images.
 *
 * Lines the pass leaves alone: fenced code, lines that already carry a
 * placement, the delimiters of a display-math block (which belong to the
 * display pass, rendered or not), indented code, and any line whose layout
 * cannot be made to fit.
 */
export function renderInlineMath(
  markdown: string,
  availableCols: number,
  renderer: FormulaPlacements,
  log: (message: string) => void = () => {},
): string {
  const records = scanLines(markdown);
  const work: { record: LineRecord; spans: InlineSpan[]; placed: (PlacedFormula | undefined)[] }[] = [];

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
    const spans = findInlineSpans(text);
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

  let emitted = 0;
  const replacements = new Map<number, string>();
  for (const { record, spans, placed: linePlacements } of work) {
    const replacement = renderLine(record, spans, linePlacements, availableCols, log);
    if (replacement === undefined) continue;
    replacements.set(record.index, replacement);
    emitted += 1;
  }
  log(`inline lines=${work.length} replaced=${emitted}`);
  return records.map((record) => replacements.get(record.index) ?? record.text).join("\n");
}

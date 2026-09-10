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

import { allocateImageId, displayCommand } from "./kitty.ts";
import type { PlacementLookup } from "./blocks.ts";
import type { FormulaRequest, RenderEntry } from "./render.ts";

/** One inline math span inside a line. */
export interface InlineSpan {
  /** Offset of the opening delimiter. */
  start: number;
  /** Offset just past the closing delimiter. */
  end: number;
  /** LaTeX source without delimiters. */
  latex: string;
}

export interface InlineRenderer extends PlacementLookup {
  renderMissing(requests: FormulaRequest[]): Map<string, RenderEntry>;
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

/** Mirrors `looksLikePendingDollarMath` in pi-tui: does the tail look like math? */
function looksLikeLatex(source: string): boolean {
  return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
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

/**
 * Markdown structure in front of a line's content.
 *
 * The pass owns the line layout, so it has to keep the structure that made the
 * line what it is: blockquote rows need their `>` on every row, list
 * continuations must stay indented to the item's content column, and a line
 * indented four columns is a code block rather than a paragraph, so its LaTeX
 * must be left alone.
 */
export interface LinePrefix {
  /** Text that opens the first row, exactly as it appeared. */
  prefix: string;
  /** Text that opens every following row (indentation, `> `, item alignment). */
  continuation: string;
  firstCols: number;
  continuationCols: number;
  /** True for an indented code block: the line carries no markup, only indent. */
  code: boolean;
}

/** Visible columns of a whitespace run; pi expands a tab to three spaces. */
function whitespaceCols(text: string): number {
  let columns = 0;
  for (const character of text) columns += character === "\t" ? 3 : 1;
  return columns;
}

const QUOTE_GROUP = /[ \t]*>[ \t]?/y;
const LIST_MARKER = /(?:[-*+]|\d{1,9}[.)])[ \t]+/y;

/** Parse the block structure in front of a line's content. */
export function linePrefix(line: string): LinePrefix {
  let index = 0;
  let quotes = "";
  let quoteContinuation = "";
  for (;;) {
    QUOTE_GROUP.lastIndex = index;
    const match = QUOTE_GROUP.exec(line);
    if (match === null) break;
    index += match[0].length;
    quotes += match[0];
    quoteContinuation += `${/^[ \t]*/.exec(match[0])?.[0] ?? ""}> `;
  }

  const indent = /^[ \t]*/.exec(line.slice(index))?.[0] ?? "";
  index += indent.length;
  LIST_MARKER.lastIndex = index;
  const marker = LIST_MARKER.exec(line)?.[0] ?? "";
  index += marker.length;

  const prefix = line.slice(0, index);
  // A list marker becomes blanks so continuation rows line up with the item
  // text; blockquote markers stay, because markdown needs them on every row.
  const continuation = `${quoteContinuation}${" ".repeat(whitespaceCols(indent) + whitespaceCols(marker))}`;
  const code = quotes === "" && marker === "" && whitespaceCols(indent) >= 4;
  return {
    prefix,
    continuation,
    firstCols: whitespaceCols(prefix),
    continuationCols: whitespaceCols(continuation),
    code,
  };
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
  line: string,
  spans: InlineSpan[],
  availableCols: number,
  renderer: InlineRenderer,
  log: (message: string) => void,
): string | undefined {
  const structure = linePrefix(line);
  if (structure.code) return undefined;
  const pieces: { span: InlineSpan; token?: Token }[] = spans.map((span) => ({ span }));

  let cursor = structure.prefix.length;
  const tokens: Token[] = [];
  for (const piece of pieces) {
    const before = line.slice(cursor, piece.span.start);
    const entry = renderer.cached({ latex: piece.span.latex, display: "inline" });
    if (!entry) {
      log(`inline: no image for ${JSON.stringify(piece.span.latex.slice(0, 40))}`);
      return undefined;
    }
    const { cols } = renderer.placement(entry);
    const command = displayCommand(entry.path, allocateImageId(), cols, 1);
    piece.token = { kind: "image", text: `${command}${" ".repeat(cols)}`, width: cols };
    tokens.push(...textTokens(before), piece.token);
    cursor = piece.span.end;
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
 * Lines that already carry a placement (display math replaced by the display
 * pass) and fenced code are left alone, as is any line whose layout cannot be
 * made to fit.
 */
export function renderInlineMath(
  markdown: string,
  availableCols: number,
  renderer: InlineRenderer,
  log: (message: string) => void = () => {},
): string {
  const lines = markdown.split("\n");
  const work: { index: number; line: string; spans: InlineSpan[] }[] = [];
  let fence: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      fence = fence === undefined ? marker : marker[0] === fence[0] && marker.length >= fence.length ? undefined : fence;
      continue;
    }
    if (fence !== undefined) continue;
    if (line.includes("\x1b_G")) continue;
    if (line.trimStart().startsWith("$$")) continue;
    // An indented code block is not a paragraph: leave its contents alone, and
    // do not render formulas that would only be thrown away.
    if (linePrefix(line).code) continue;
    if (!line.includes("$") && !line.includes("\\(") && !line.includes("\\[")) continue;
    const spans = findInlineSpans(line);
    if (spans.length > 0) work.push({ index, line, spans });
  }
  if (work.length === 0) return markdown;

  const missing: FormulaRequest[] = [];
  const seen = new Set<string>();
  for (const { spans } of work) {
    for (const span of spans) {
      const request: FormulaRequest = { latex: span.latex, display: "inline" };
      if (seen.has(span.latex) || renderer.cached(request)) continue;
      seen.add(span.latex);
      missing.push(request);
    }
  }
  if (missing.length > 0) {
    const rendered = renderer.renderMissing(missing);
    log(`inline rendered ${rendered.size}/${missing.length} formula(s)`);
  }

  let emitted = 0;
  for (const { index, line, spans } of work) {
    const replacement = renderLine(line, spans, availableCols, renderer, log);
    if (replacement === undefined) continue;
    lines[index] = replacement;
    emitted += 1;
  }
  log(`inline lines=${work.length} replaced=${emitted}`);
  return lines.join("\n");
}

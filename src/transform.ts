/**
 * Markdown scanning for display math.
 *
 * pi's markdown renderer recognises display math with pi-tui's `latexBlock`
 * tokenizer, which only matches `$$…$$` and `\[…\]` when they begin a block
 * (line start, at most three leading spaces) and close with a delimiter followed
 * by end of line. This module mirrors those rules, so the transformer replaces
 * exactly the spans pi would otherwise typeset as math and leaves inline math
 * (`$…$`, `\(…\)`) to pi's own renderer.
 */

import { scanLines } from "./structure.ts";

/** A display-math block found in markdown source. */
export interface DisplayMathSpan {
  /** Offset of the span start (first character of the block, including indent). */
  start: number;
  /** Offset just past the span end. */
  end: number;
  /** LaTeX source without delimiters. */
  latex: string;
}

/**
 * Sticky block patterns, anchored at a line start.
 *
 * `y` forces the match to begin exactly at `lastIndex`, which lets the scanner
 * try every line start without the offset arithmetic a `(?:^|\n)` prefix needs.
 */
const DOLLAR_BLOCK = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?=\n|$)/my;
const BRACKET_BLOCK = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?=\n|$)/my;

/**
 * Does this line begin display math? The line-level half of the rules above.
 *
 * The inline pass asks this so it never typesets the delimiters of a block the
 * display pass owns, including a block whose render failed and whose source is
 * still in the message.
 */
export function beginsDisplayMath(line: string): boolean {
  return /^ {0,3}(?:\$\$|\\\[)/.test(line);
}

/** Blank-line separator that keeps a replacement in its own paragraph. */
function leadingSeparator(boundary: string): string {
  if (boundary === "" || /^\s*$/.test(boundary)) return "";
  if (boundary.endsWith("\n\n")) return "";
  return boundary.endsWith("\n") ? "\n" : "\n\n";
}

function trailingSeparator(boundary: string): string {
  if (boundary === "" || /^\s*$/.test(boundary)) return "";
  if (boundary.startsWith("\n\n")) return "";
  return boundary.startsWith("\n") ? "\n" : "\n\n";
}

/**
 * Find every display-math span outside fenced code blocks, in source order.
 */
export function findDisplayMathSpans(markdown: string): DisplayMathSpan[] {
  // Every candidate span begins at a line start, so fenced and table lines are
  // tested by offset. The rules for both live in the shared line scan: a display
  // block that begins on a table row is a row of that table to the parser, not
  // a block, and replacing it would insert the blank filler lines that end the
  // table.
  const owned = new Set(
    scanLines(markdown)
      .filter((line) => line.fence || line.table !== undefined)
      .map((line) => line.start),
  );
  const spans: DisplayMathSpan[] = [];
  let position = 0;
  while (position <= markdown.length) {
    let matched = false;
    for (const pattern of [DOLLAR_BLOCK, BRACKET_BLOCK]) {
      pattern.lastIndex = position;
      const match = pattern.exec(markdown);
      if (!match) continue;
      const body = (match[1] ?? "").trim();
      const end = position + match[0].length;
      matched = true;
      if (body && !owned.has(position)) {
        spans.push({ start: position, end, latex: body });
      }
      position = end > position ? end : position + 1;
      break;
    }
    if (matched) continue;
    const nextBreak = markdown.indexOf("\n", position);
    if (nextBreak === -1) break;
    position = nextBreak + 1;
  }
  return spans;
}

/**
 * Replace spans with rendered text.
 *
 * `build` returns the replacement for a span, or `undefined` to keep the source.
 * Replacements are surrounded by blank lines so each one starts its own
 * paragraph: a replacement contains blank lines itself, and merging it into a
 * neighbouring paragraph would place raw newlines inside a rendered line and
 * desynchronise the terminal row accounting.
 */
export function replaceDisplayMath(
  markdown: string,
  build: (span: DisplayMathSpan) => string | undefined,
  spans: DisplayMathSpan[] = findDisplayMathSpans(markdown),
): string {
  if (spans.length === 0) return markdown;
  let output = "";
  let cursor = 0;
  for (const span of spans) {
    const replacement = build(span);
    output += markdown.slice(cursor, span.start);
    if (replacement === undefined) {
      output += markdown.slice(span.start, span.end);
    } else {
      const leadingBreak = leadingSeparator(markdown.slice(0, span.start));
      const trailingBreak = trailingSeparator(markdown.slice(span.end));
      output += `${leadingBreak}${replacement}${trailingBreak}`;
    }
    cursor = span.end;
  }
  output += markdown.slice(cursor);
  return output;
}

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

/** A display-math block found in markdown source. */
export interface DisplayMathSpan {
  /** Offset of the span start (first character of the block, including indent). */
  start: number;
  /** Offset just past the span end. */
  end: number;
  /** LaTeX source without delimiters. */
  latex: string;
  /** Delimiter that produced the span. */
  delimiter: "$$" | "\\[";
}

/**
 * Sticky block patterns, anchored at a line start.
 *
 * `y` forces the match to begin exactly at `lastIndex`, which lets the scanner
 * try every line start without the offset arithmetic a `(?:^|\n)` prefix needs.
 */
const DOLLAR_BLOCK = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?=\n|$)/my;
const BRACKET_BLOCK = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?=\n|$)/my;

const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})/;

interface Interval {
  start: number;
  end: number;
}

/** Character ranges covered by fenced code blocks. */
export function fenceIntervals(markdown: string): Interval[] {
  const intervals: Interval[] = [];
  let offset = 0;
  let fence: string | undefined;
  let fenceStart = 0;
  for (const line of markdown.split("\n")) {
    const marker = FENCE_MARKER.exec(line)?.[1];
    if (fence === undefined) {
      if (marker) {
        fence = marker;
        fenceStart = offset;
      }
    } else if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
      intervals.push({ start: fenceStart, end: offset + line.length });
      fence = undefined;
    }
    offset += line.length + 1;
  }
  if (fence !== undefined) intervals.push({ start: fenceStart, end: markdown.length });
  return intervals;
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

function insideAny(intervals: Interval[], offset: number): boolean {
  for (const interval of intervals) {
    if (offset >= interval.start && offset < interval.end) return true;
  }
  return false;
}

/**
 * Find every display-math span outside fenced code blocks, in source order.
 */
export function findDisplayMathSpans(markdown: string): DisplayMathSpan[] {
  const fences = fenceIntervals(markdown);
  const spans: DisplayMathSpan[] = [];
  let position = 0;
  while (position <= markdown.length) {
    let matched = false;
    for (const [delimiter, pattern] of [
      ["$$", DOLLAR_BLOCK],
      ["\\[", BRACKET_BLOCK],
    ] as const) {
      pattern.lastIndex = position;
      const match = pattern.exec(markdown);
      if (!match) continue;
      const body = (match[1] ?? "").trim();
      const end = position + match[0].length;
      matched = true;
      if (body && !insideAny(fences, position)) {
        spans.push({ start: position, end, latex: body, delimiter });
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

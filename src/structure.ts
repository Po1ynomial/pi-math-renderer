/**
 * Structure of a markdown message, line by line.
 *
 * One walk owns the facts a pass needs before it may rewrite a line:
 *
 * - **fence** is document state. A fenced code block runs from its opening
 *   marker to its counterpart, and its contents (markers included) are not
 *   markdown to transform. It has to be tracked in order, so it lives here
 *   rather than in either pass.
 * - **structure** is line-local: the blockquote markers, list marker and
 *   indentation in front of the content, and whether the line is indented code.
 *
 * Offsets come along because a pass that scans the raw string (display math)
 * indexes by offset, while a pass that rewrites lines indexes by line.
 *
 * The scan is a pure function of the text, so it can run again over a message
 * that a previous pass rewrote.
 */

/** Markdown fence marker: three or more backticks or tildes, up to three spaces in. */
const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Markdown structure in front of a line's content.
 *
 * A pass that owns a line's layout has to keep the structure that made the line
 * what it is: blockquote rows need their `>` on every row, list continuations
 * must stay indented to the item's content column, and a line indented four
 * columns is a code block rather than a paragraph, so its LaTeX must be left
 * alone.
 */
export interface LineStructure {
  /** Text that opens the first row, exactly as it appeared. */
  prefix: string;
  /** Text that opens every following row (indentation, `> `, item alignment). */
  continuation: string;
  firstCols: number;
  continuationCols: number;
  /** True for an indented code block: the line carries no markup, only indent. */
  indented: boolean;
}

/** One line of a message, with everything a pass needs to decide about it. */
export interface LineRecord {
  /** Line number in the source, so a rewrite can replace the right line. */
  index: number;
  /** The line, without its newline. */
  text: string;
  /** Offset of the line's first character in the source string. */
  start: number;
  /** True inside a fenced code block, the fence markers included. */
  fence: boolean;
  /** Block structure in front of the content. */
  structure: LineStructure;
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
export function lineStructure(line: string): LineStructure {
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
  const indented = quotes === "" && marker === "" && whitespaceCols(indent) >= 4;
  return {
    prefix,
    continuation,
    firstCols: whitespaceCols(prefix),
    continuationCols: whitespaceCols(continuation),
    indented,
  };
}

/**
 * Every line of a message with its fence state and block structure.
 *
 * The line set is exactly `markdown.split("\n")`, trailing empty line included,
 * so a caller can rebuild the message from the records.
 */
export function scanLines(markdown: string): LineRecord[] {
  const records: LineRecord[] = [];
  const lines = markdown.split("\n");
  let fence: string | undefined;
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] as string;
    const marker = FENCE_MARKER.exec(text)?.[1];
    if (marker !== undefined) {
      // A marker closes the block only when it repeats the opening character at
      // least as many times; anything else is content.
      fence =
        fence === undefined
          ? marker
          : marker[0] === fence[0] && marker.length >= fence.length
            ? undefined
            : fence;
    }
    records.push({
      index,
      text,
      start: offset,
      fence: marker !== undefined || fence !== undefined,
      structure: lineStructure(text),
    });
    offset += text.length + 1;
  }
  return records;
}
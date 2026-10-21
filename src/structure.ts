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
 * - **table** is document state as well, and it is the one fact a pass cannot
 *   work out for itself: whether the parser reads the line as part of a table.
 *   A table row is laid out by pi's table renderer rather than by a markdown
 *   pass, down to the width of every cell.
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
  /** Blockquote markers in front of the line, exactly as they appeared. */
  quote: string;
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
  /**
   * How the parser reads this line in a table, or `undefined` when it is not
   * part of one. pi renders the header and body rows through its table
   * renderer, which sizes and pads every cell from the source text.
   */
  table: TableRole | undefined;
}

/** How pi's markdown parser reads a line of a table. */
export type TableRole = "header" | "delimiter" | "row";

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
    quote: quotes,
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
      table: undefined,
    });
    offset += text.length + 1;
  }
  markTableLines(records);
  return records;
}

/**
 * The parser's table rule, ported from marked's gfm `table` tokenizer.
 *
 * Two parts of it are easy to get wrong, and both are load-bearing here. A
 * delimiter row is a run of dashes with optional colons, so `--- | ---` is one
 * and `---` alone is a thematic break rather than a table under nothing; and a
 * delimiter row only counts when it holds a `:` or a `|`. So `a` over `---` is
 * a heading, not a one-column table.
 */
const TABLE_DELIMITER = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;
const TABLE_DELIMITER_MARK = /[:|]/;

/**
 * Block starts that end a table's rows, from the same rule's exclusions.
 *
 * The list is deliberately only what the parser refuses: a line this calls a
 * row is a row to the parser, and a line it wrongly calls a block start is a
 * row that a pass will treat as a paragraph, which is how a table gets broken.
 */
const TABLE_HR = /^ {0,3}(?:- *){3,}$|^ {0,3}(?:_ *){3,}$|^ {0,3}(?:\* *){3,}$/;
const TABLE_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const TABLE_QUOTE = /^ {0,3}>/;
const TABLE_LIST = /^ {0,3}(?:[*+-]|1[.)])[ \t]/;

/**
 * True when the line is the delimiter row of a table, taking the line without
 * any blockquote or list structure in front of it.
 */
export function isTableDelimiter(line: string): boolean {
  return TABLE_DELIMITER.test(line) && TABLE_DELIMITER_MARK.test(line);
}

/**
 * The cells of one table row, split the way the parser splits them: on
 * unescaped pipes, trimmed, with `\|` unescaped, and with the empty ends of a
 * row dropped.
 */
export function splitTableCells(row: string): string[] {
  const separated = row.replace(/\|/g, (pipe: string, offset: number) => {
    let backslashes = 0;
    for (let index = offset - 1; index >= 0 && row[index] === "\\"; index -= 1) backslashes += 1;
    return backslashes % 2 === 1 ? pipe : " |";
  });
  const cells = separated.split(" |");
  if (!(cells[0] as string).trim()) cells.shift();
  if (cells.length > 0 && !(cells[cells.length - 1] as string)?.trim()) cells.pop();
  return cells.map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** The line with any blockquote or list structure in front of its content removed. */
export function lineContent(record: LineRecord): string {
  return record.text.slice(record.structure.prefix.length);
}

/** The line as the table's own container sees it: only its quote markers removed. */
function containerLine(record: LineRecord, quote: string): string {
  return record.text.slice(quote.length);
}

/**
 * True when the line may start a table.
 *
 * The check is on the line's content rather than the whole line, because a
 * list item's content is a block of its own: `- | a | b |` over an indented
 * delimiter row is a table inside the item rather than a list item followed by
 * a paragraph.
 */
function tableHeaderLike(record: LineRecord): boolean {
  if (record.fence || record.structure.indented) return false;
  const content = lineContent(record);
  if (content.trim() === "") return false;
  return !TABLE_HR.test(content) && !TABLE_HEADING.test(content) && !TABLE_LIST.test(content);
}

/**
 * True when the parser may read the line as a row of the table rather than as
 * another block.
 *
 * This one runs against the line with the container's quote markers removed but
 * the line's own indentation and marker kept, because that is what the parser
 * decides on: a `- item` or a nested `> quote` under a table starts a block and
 * ends the table's rows, while the same text inside the table is a row.
 */
function tableRowLike(record: LineRecord, quote: string): boolean {
  if (record.fence || record.structure.indented) return false;
  if (record.structure.quote !== quote) return false;
  const line = containerLine(record, quote);
  if (line.trim() === "") return false;
  return !TABLE_HR.test(line) && !TABLE_HEADING.test(line) && !TABLE_QUOTE.test(line) && !TABLE_LIST.test(line);
}

/**
 * True when the header row and the delimiter row agree on their cell count.
 *
 * The parser refuses the pair otherwise: `h` over `--- | ---` is a paragraph
 * over a thematic break rather than a one-cell table over two cells, and a
 * delimiter row with a cell the header does not have makes the run a paragraph
 * rather than a table. Marking a line the parser does not read as a row would
 * hold its formulas back for nothing.
 */
function headerMatchesDelimiter(header: string, delimiter: string): boolean {
  return splitTableCells(header).length === splitTableCells(delimiter).length;
}

/**
 * Mark the lines the parser reads as one table.
 *
 * A table starts at a header line whose successor is a delimiter row with as
 * many cells as the header, and runs on through every following line until a
 * blank line or another block starts, pipes or no pipes: after `| a | b |` and
 * `| --- | --- |`, a plain line of prose is a one-cell row. The walk consumes a
 * whole table before it looks for the next one, which is what the parser does
 * too: a second header and delimiter inside a table's rows are simply more
 * rows.
 */
function markTableLines(records: LineRecord[]): void {
  let quote: string | undefined;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as LineRecord;
    if (quote !== undefined) {
      if (tableRowLike(record, quote)) {
        record.table = "row";
        continue;
      }
      // The run ended here; the line may yet start the next table.
      quote = undefined;
    }
    const next = records[index + 1];
    if (next === undefined) continue;
    if (!tableHeaderLike(record)) continue;
    const container = record.structure.quote;
    if (next.structure.quote !== container) continue;
    if (next.fence || next.structure.indented) continue;
    const delimiter = containerLine(next, container);
    if (!isTableDelimiter(delimiter)) continue;
    if (!headerMatchesDelimiter(lineContent(record), delimiter)) continue;
    record.table = "header";
    next.table = "delimiter";
    quote = container;
    index += 1;
  }
}

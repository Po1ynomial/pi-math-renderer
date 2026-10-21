import assert from "node:assert/strict";
import { test } from "node:test";
import { lineStructure, scanLines, splitTableCells } from "../src/structure.ts";

/** Lines the scan says are inside a fenced code block. */
function fencedLines(markdown: string): string[] {
  return scanLines(markdown)
    .filter((record) => record.fence)
    .map((record) => record.text);
}

/** How the scan reads each line in a table, `-` when it is not part of one. */
function tableRoles(markdown: string): string[] {
  return scanLines(markdown).map((record) => record.table ?? "-");
}

test("a fence covers its markers and everything between them", () => {
  assert.deepEqual(fencedLines("a\n```\nx\n```\nb\n"), ["```", "x", "```"]);
  assert.deepEqual(fencedLines("a\n~~~\nx\n~~~\nb\n"), ["~~~", "x", "~~~"]);
});

test("a fence closes only on its own character and length", () => {
  // A longer fence of another character, or a shorter one of the same
  // character, is content rather than a close.
  assert.deepEqual(fencedLines("```\na\n~~~\nb\n````\n"), ["```", "a", "~~~", "b", "````"]);
  assert.deepEqual(fencedLines("````\n```\nb\n````\n"), ["````", "```", "b", "````"]);
  assert.deepEqual(fencedLines("~~~\nb\n```\nc\n~~~\n"), ["~~~", "b", "```", "c", "~~~"]);
});

test("an unclosed fence runs to the end of the message", () => {
  assert.deepEqual(fencedLines("a\n```\nx\n"), ["```", "x", ""]);
});

test("an indented fence still hides its contents", () => {
  assert.deepEqual(fencedLines("  ```\n  x\n  ```\n"), ["  ```", "  x", "  ```"]);
});

test("lines keep their offsets and count, trailing empty line included", () => {
  const markdown = "a\n\nlast\n";
  const records = scanLines(markdown);
  assert.deepEqual(
    records.map((record) => record.text),
    ["a", "", "last", ""],
  );
  assert.deepEqual(
    records.map((record) => markdown.slice(record.start, record.start + record.text.length)),
    ["a", "", "last", ""],
  );
  assert.deepEqual(
    records.map((record) => record.index),
    [0, 1, 2, 3],
  );
});

test("the line's block structure is parsed, not guessed", () => {
  assert.deepEqual(lineStructure("plain text"), {
    prefix: "",
    continuation: "",
    quote: "",
    firstCols: 0,
    continuationCols: 0,
    indented: false,
  });
  assert.deepEqual(lineStructure("  - item"), {
    prefix: "  - ",
    continuation: "    ",
    quote: "",
    firstCols: 4,
    continuationCols: 4,
    indented: false,
  });
  assert.deepEqual(lineStructure("> quote"), {
    prefix: "> ",
    continuation: "> ",
    quote: "> ",
    firstCols: 2,
    continuationCols: 2,
    indented: false,
  });
  assert.equal(lineStructure("> > - x").quote, "> > ", "a nested quote keeps both markers");
  assert.equal(lineStructure("    code").indented, true);
  assert.equal(lineStructure("\tcode").indented, false, "one tab is three columns, pi expands it");
  assert.equal(lineStructure(" \tcode").indented, true);
});

test("a fence marker needs three leading spaces or fewer", () => {
  assert.deepEqual(fencedLines("   ```\nx\n   ```\n"), ["   ```", "x", "   ```"]);
  assert.deepEqual(fencedLines("    ```\nx\n"), [], "four spaces is an indented code block");
  const [indented] = scanLines("    ```\n");
  assert.equal(indented?.structure.indented, true);
});

test("a table's header, delimiter and rows are marked", () => {
  assert.deepEqual(tableRoles("| h | h |\n| --- | --- |\n| 1 | 2 |\n"), [
    "header",
    "delimiter",
    "row",
    "-",
  ]);
  assert.deepEqual(tableRoles("prose\n\n| h |\n| --- |\n| 1 |\n"), [
    "-",
    "-",
    "header",
    "delimiter",
    "row",
    "-",
  ]);
  // A row needs no pipe: after the delimiter row every line is a row until a
  // blank line or another block starts. This is how a re-flowed row was read
  // back as extra rows with the wrong columns.
  assert.deepEqual(tableRoles("| h |\n| --- |\nplain prose\n"), ["header", "delimiter", "row", "-"]);
  assert.deepEqual(tableRoles("| h |\n| --- |\n| a |\n| --- |\n"), [
    "header",
    "delimiter",
    "row",
    "row",
    "-",
  ]);
});

test("a table's rows end at a blank line or another block", () => {
  const header = "| h |\n| --- |\n";
  assert.deepEqual(tableRoles(`${header}\nprose\n`), ["header", "delimiter", "-", "-", "-"]);
  assert.deepEqual(tableRoles(`${header}## heading\n`), ["header", "delimiter", "-", "-"]);
  assert.deepEqual(tableRoles(`${header}- item\n`), ["header", "delimiter", "-", "-"]);
  assert.deepEqual(tableRoles(`${header}---\n`), ["header", "delimiter", "-", "-"]);
  assert.deepEqual(tableRoles(`${header}> quote\n`), ["header", "delimiter", "-", "-"]);
  assert.deepEqual(tableRoles(`${header}    code\n`), ["header", "delimiter", "-", "-"]);
  assert.deepEqual(tableRoles(`${header}\`\`\`\nx\n`), [
    "header",
    "delimiter",
    "-",
    "-",
    "-",
  ]);
});

test("a table needs a delimiter row, pipes or no pipes", () => {
  // `---` alone is a thematic break, and paired with a header it is a setext
  // heading, not a one-column table.
  assert.deepEqual(tableRoles("h\n---\n"), ["-", "-", "-"]);
  assert.deepEqual(tableRoles("| h |\n| - |\n"), ["header", "delimiter", "-"]);
  assert.deepEqual(tableRoles("| h |\n| :-- |\n"), ["header", "delimiter", "-"]);
  // A delimiter row is dashes and colons only, so a stray cell makes the line
  // under the header a paragraph.
  assert.deepEqual(tableRoles("| h |\n| --- | extra |\n"), ["-", "-", "-"]);
  // `# h` is a heading, so the delimiter-looking line under it is a paragraph.
  assert.deepEqual(tableRoles("# h | x |\n| --- |\n"), ["-", "-", "-"]);
  // The header and the delimiter row have to agree on their cell count, or the
  // parser reads the pair as a paragraph.
  assert.deepEqual(tableRoles("| a | b |\n| --- | --- | --- |\n| 1 | 2 |"), [
    "-",
    "-",
    "-",
  ]);
  assert.deepEqual(tableRoles("| a | b | c |\n| --- | --- |\n| 1 | 2 |"), [
    "-",
    "-",
    "-",
  ]);
});

test("a table inside another block is still a table", () => {
  assert.deepEqual(tableRoles("> | h |\n> | --- |\n> | 1 |\n"), ["header", "delimiter", "row", "-"]);
  assert.deepEqual(tableRoles("  | h |\n  | --- |\n  | 1 |\n"), ["header", "delimiter", "row", "-"]);
});

test("cells split on unescaped pipes, like the parser splits them", () => {
  assert.deepEqual(splitTableCells("| a | b |"), ["a", "b"]);
  assert.deepEqual(splitTableCells("a | b"), ["a", "b"]);
  assert.deepEqual(splitTableCells("| x \\| y | z |"), ["x | y", "z"]);
  assert.deepEqual(splitTableCells("| a |"), ["a"]);
});
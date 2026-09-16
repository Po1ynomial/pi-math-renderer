import assert from "node:assert/strict";
import { test } from "node:test";
import { lineStructure, scanLines } from "../src/structure.ts";

/** Lines the scan says are inside a fenced code block. */
function fencedLines(markdown: string): string[] {
  return scanLines(markdown)
    .filter((record) => record.fence)
    .map((record) => record.text);
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
    firstCols: 0,
    continuationCols: 0,
    indented: false,
  });
  assert.deepEqual(lineStructure("  - item"), {
    prefix: "  - ",
    continuation: "    ",
    firstCols: 4,
    continuationCols: 4,
    indented: false,
  });
  assert.deepEqual(lineStructure("> quote"), {
    prefix: "> ",
    continuation: "> ",
    firstCols: 2,
    continuationCols: 2,
    indented: false,
  });
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
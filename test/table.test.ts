/**
 * Tables with math in them.
 *
 * pi's table renderer owns a table's layout: it sizes every column from the
 * widest cell and pads the rest, so a placement in a cell has to be written the
 * way that renderer expects, and a row must never be re-flowed - a line break
 * inside a row is read as another row.
 *
 * These tests drive the real pass and then render its output through pi's own
 * `Markdown` component, which is where the bugs showed up: a split row came
 * back as a table with the wrong columns, and a cell whose trailing spaces were
 * trimmed painted the formula over its own border.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { renderInlineMath } from "../src/inline.ts";
import { transformMessage } from "../src/pipeline.ts";
import type { FormulaPlacements, PlacedFormula } from "../src/render.ts";

const identity = (text: string): string => text;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity,
  codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity,
  listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity,
};

/** Renderer stub: one placement per request, `widthCells` cells wide. */
function stubRenderer(widthCells = 8) {
  const requested: string[][] = [];
  const stub: FormulaPlacements = {
    placements(requests) {
      requested.push(requests.map((request) => request.latex));
      return requests.map(
        (request): PlacedFormula => ({
          key: `${request.display}:${request.latex}`,
          path: `/tmp/formula-${request.latex}.png`,
          cols: widthCells,
          rows: 1,
        }),
      );
    },
  };
  return { stub, requested };
}

/** Renderer stub that refuses everything, the way a broken formula does. */
const refusing: FormulaPlacements = { placements: (requests) => requests.map(() => undefined) };

const KITTY = /\x1b_G([^;]*);[^\x1b]*\x1b\\/g;

/** Cell widths the placements on a line declare. */
function placementCols(text: string): number[] {
  return [...text.matchAll(KITTY)].map((match) =>
    Number.parseInt(/,c=(\d+)/.exec(match[1] as string)?.[1] ?? "1", 10),
  );
}

/** Column of every table border glyph on a rendered line, escapes removed. */
function borderCols(line: string): number[] {
  const clean = line
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/g, "")
    .replace(KITTY, "");
  const cols: number[] = [];
  let visible = 0;
  for (const character of clean) {
    if ("┌┬┐├┼┤└┴┘│─".includes(character)) cols.push(visible);
    // Columns, not characters: a wide character occupies two of them.
    visible += visibleWidth(character);
  }
  return cols;
}

/**
 * Border columns of the table's content rows, in order.
 *
 * A rendered table also has rule lines (dashes and corners) and, inside a
 * blockquote, a quote marker that is itself a `│`; a content row is the only
 * line with two or more of them.
 */
function rowBorders(lines: string[]): number[][] {
  return lines.filter((line) => line.split("│").length >= 3).map(borderCols);
}

/** Blanks between each placement on a line and the next text after it. */
function blanksAfterPlacement(line: string): number[] {
  return [...line.matchAll(KITTY)].map((match) => {
    const rest = line.slice((match.index as number) + match[0].length).replace(/\x1b\[[0-9;]*m/g, "");
    return /^ */.exec(rest)?.[0].length ?? 0;
  });
}

const render = (markdown: string, width: number): string[] =>
  new Markdown(markdown, 0, 0, theme).render(width);

/**
 * The invariants a table with a placement in it has to keep: rows stay rows,
 * every row's borders line up, and no placement is painted over by the cells
 * that follow it.
 */
function assertTableIntact(source: string, output: string, width: number): void {
  assert.equal(
    output.split("\n").length,
    source.split("\n").length,
    "the transform may not add or remove lines",
  );
  const before = render(source, width);
  const after = render(output, width);
  assert.equal(after.length, before.length, "the table may not gain or lose rows");
  const rows = rowBorders(after);
  const expected = rows[0] as number[];
  for (const row of rows) assert.deepEqual(row, expected, "a row's borders moved");
  for (const line of after) {
    const cols = placementCols(line);
    const blanks = blanksAfterPlacement(line);
    blanks.forEach((blanks, index) => {
      assert.ok(
        blanks >= (cols[index] as number),
        `a placement of ${cols[index]} cells is followed by only ${blanks} blanks`,
      );
    });
  }
}

test("a row carrying math is written as one line, with its advance spaces protected", () => {
  const source = "| a | b |\n| --- | --- |\n| mass | $E = mc^2$ |";
  const { stub } = stubRenderer(8);
  const output = renderInlineMath(source, 60, stub);
  assert.deepEqual(placementCols(output), [8]);
  // The cell would end in the advance spaces, and the parser trims a cell's
  // trailing whitespace, so a reset closes the run.
  assert.match(output, /\x1b\\ {8}\x1b\[39m \|$/m);
  assertTableIntact(source, output, 60);
});

test("math in the header row and in several cells of a row still renders", () => {
  const source = "| $n$ | value |\n| --- | --- |\n| $x$ | $y$ |";
  const { stub } = stubRenderer(3);
  const output = renderInlineMath(source, 60, stub);
  assert.deepEqual(placementCols(output), [3, 3, 3]);
  assertTableIntact(source, output, 60);
});

test("a table whose rows would not fit the width keeps its LaTeX", () => {
  // The source row is 27 columns and fits 30; the placements add five more.
  const source = "| k | d |\n| --- | --- |\n| a | bbbbbbbbbbbbbbb $E$ |";
  const { stub } = stubRenderer(8);
  assert.equal(renderInlineMath(source, 30, stub), source);
  // One cell wider and the table fits again, so the same message does render.
  const fits = renderInlineMath(source, 32, stub);
  assert.deepEqual(placementCols(fits), [8]);
  assertTableIntact(source, fits, 32);
});

test("the table width is measured like pi measures it", () => {
  // Column widths come from the widest cell, so one wide row elsewhere in the
  // table is enough to push the placements out of the available width.
  const narrow = "| a | b |\n| --- | --- |\n| $x$ | short |";
  const wide = "| a | b |\n| --- | --- |\n| $x$ | short |\n| y | a cell far too wide for forty columns |";
  const { stub } = stubRenderer(20);
  assert.equal(placementCols(renderInlineMath(narrow, 40, stub)).length, 1);
  assert.equal(renderInlineMath(wide, 40, stub), wide);
  assertTableIntact(narrow, renderInlineMath(narrow, 40, stub), 40);
});

test("math is not read across a cell boundary", () => {
  const source = "| a | b |\n| --- | --- |\n| $x | y$ |";
  const { stub, requested } = stubRenderer();
  assert.equal(renderInlineMath(source, 60, stub), source);
  assert.deepEqual(requested, [], "a `$` pair that spans two cells is not math to pi");
});

test("a table without math is returned byte for byte", () => {
  const source = "| a | b |\n| --- | --- |\n| 1 | two |";
  assert.equal(renderInlineMath(source, 60, refusing), source);
});

test("a plain table in a table-heavy message renders and leaves the prose alone", () => {
  const source = [
    "Prose with $x$ in it.",
    "",
    "| a | b |",
    "| --- | --- |",
    "| $n$ | two |",
    "",
    "Prose after.",
  ].join("\n");
  const { stub } = stubRenderer(2);
  const output = renderInlineMath(source, 60, stub);
  assert.deepEqual(placementCols(output), [2, 2]);
  assert.equal(output.split("\n").length, source.split("\n").length);
});

test("a table inside a blockquote keeps its markers", () => {
  const source = "> | a | b |\n> | --- | --- |\n> | $x$ | two |";
  const { stub } = stubRenderer(3);
  const output = renderInlineMath(source, 60, stub);
  assert.deepEqual(placementCols(output), [3]);
  for (const line of output.split("\n")) assert.match(line, /^> /);
  assertTableIntact(source, output, 60);
});

test("every table the pass accepts renders without a wrapped cell", () => {
  // Wrapping a cell splits the placement, so the estimate that decides whether
  // a table fits is only safe if it never accepts a table pi then shrinks. Each
  // case here is rendered for real and checked.
  const cases: [string, number][] = [
    ["| a | b |\n| --- | --- |\n| $x$ | 2 |", 60],
    ["| a | b |\n| --- | --- |\n| **bold** | $x$ |", 60],
    ["| a | b |\n| --- | --- |\n| [link](https://example.com/x) | $x$ |", 60],
    ["| a | b |\n| --- | --- |\n| a \\| b | $x$ |", 60],
    ["| 名前 | 説明 |\n| --- | --- |\n| 質量 | $x$ |", 60],
    ["| $x$ | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |", 40],
    ["| a | b |\n| --- | --- |\n| $x$ | a cell far too wide for forty columns |", 40],
  ];
  for (const [source, width] of cases) {
    const output = renderInlineMath(source, width, stubRenderer(6).stub);
    if (placementCols(output).length === 0) continue;
    assertTableIntact(source, output, width);
  }
});

test("a placement that the renderer refuses keeps the row's source", () => {
  const source = "| a | b |\n| --- | --- |\n| mass | $x$ |";
  const output = renderInlineMath(source, 60, refusing);
  assert.equal(output, source);
  assertTableIntact(source, output, 60);
});

test("table rows do not outgrow the width they were accepted for", () => {
  const source = "| a | b |\n| --- | --- |\n| $x$ | two |";
  const { stub } = stubRenderer(4);
  const output = renderInlineMath(source, 24, stub);
  for (const line of output.split("\n")) {
    assert.ok(visibleWidth(line) <= 24, `${JSON.stringify(line)} is wider than 24 columns`);
  }
});

test("a table and a display block render in the same message", () => {
  // The inline pass runs over the display pass's output, which is image lines
  // and filler lines rather than markdown, so a table has to survive that.
  const source = [
    "| a | b |",
    "| --- | --- |",
    "| $n$ | two |",
    "",
    "$$",
    "\\int_0^1 x^2 \\, dx",
    "$$",
  ].join("\n");
  const { stub } = stubRenderer(3);
  const output = transformMessage(
    source,
    { messageType: "assistant", isStreaming: false, availableWidth: 60 },
    stub,
  );
  assert.equal(output.split("\n").length, source.split("\n").length - 2);
  assert.deepEqual(placementCols(output), [3, 3]);
  // The table's row is still one row, and its placement has its advance spaces.
  const tableRow = output.split("\n")[2] as string;
  assert.match(tableRow, /^\| \x1b_G.*\x1b\\ {3}\x1b\[39m \|/);
  const rows = rowBorders(render(output, 60));
  for (const row of rows) assert.deepEqual(row, rows[0]);
});

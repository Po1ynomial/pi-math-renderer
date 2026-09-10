import assert from "node:assert/strict";
import { test } from "node:test";
import { findInlineSpans, linePrefix, renderInlineMath, type InlineRenderer } from "../src/inline.ts";
import type { FormulaRequest, RenderEntry } from "../src/render.ts";

/** Renderer stub: one PNG per distinct LaTeX source, no service involved. */
function stubRenderer(widthCells = 3) {
  const entries = new Map<string, RenderEntry>();
  const requested: string[][] = [];
  const stub: InlineRenderer = {
    cached(request) {
      return entries.get(`${request.display}:${request.latex}`);
    },
    renderMissing(requests) {
      requested.push(requests.map((request) => request.latex));
      const rendered = new Map<string, RenderEntry>();
      for (const request of requests) {
        const index = entries.size;
        const entry: RenderEntry = {
          key: `key-${index}`,
          path: `/tmp/formula-${index}.png`,
          widthPx: widthCells * 11,
          heightPx: 23,
        };
        entries.set(`${request.display}:${request.latex}`, entry);
        rendered.set(`${request.display}\u0000${request.latex}`, entry);
      }
      return rendered;
    },
    placement(entry) {
      return { cols: Math.round(entry.widthPx / 11), rows: 1 };
    },
  };
  return { stub, requested, entries };
}

const idsIn = (text: string): number[] =>
  [...text.matchAll(/i=(\d+)/g)].map((match) => Number.parseInt(match[1]!, 10));

test("the scanner follows pi's delimiter rules", () => {
  const lateces = (line: string): string[] => findInlineSpans(line).map((span) => span.latex);
  assert.deepEqual(lateces("see $x^{2}$ here"), ["x^{2}"]);
  assert.deepEqual(lateces("see \\(x^{2}\\) here"), ["x^{2}"]);
  assert.deepEqual(lateces("see \\[x^{2}\\] here"), ["x^{2}"]);
  assert.deepEqual(lateces("two: $a$ and $b$"), ["a", "b"]);
  // prices, identifiers and escapes
  assert.deepEqual(lateces("costs $5 and $6 total"), []);
  assert.deepEqual(lateces("write $x$5 dollars"), []);
  assert.deepEqual(lateces("the $A_B$C token"), []);
  assert.deepEqual(lateces("escaped \\$x$ y"), []);
  assert.deepEqual(lateces("an empty $$ pair"), []);
  // whitespace guards and code spans
  assert.deepEqual(lateces("padding $ x $ out"), []);
  assert.deepEqual(lateces("padding $x $ out"), []);
  assert.deepEqual(lateces("a `$x$` code span"), []);
});

test("a line whose inline math fits becomes one image line", () => {
  const { stub, requested } = stubRenderer();
  const output = renderInlineMath("value $x$ here", 40, stub);
  assert.deepEqual(requested, [["x"]]);
  assert.match(output, /^value \x1b_Ga=T,f=100,q=2,t=f,c=3,r=1,C=1,i=\d+;/);
  // three cells of image, advanced over with spaces, then the rest of the line
  assert.match(output, /i=\d+;[A-Za-z0-9+/=]+\x1b\\ {3} here$/);
});

test("each placement gets its own image id", () => {
  const { stub } = stubRenderer();
  const output = renderInlineMath("$x$ and $x$", 40, stub);
  const ids = idsIn(output);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test("a long line is re-flowed so every emitted line fits", () => {
  const { stub } = stubRenderer(6);
  const line = `alpha beta gamma delta $x$ epsilon zeta eta theta iota`;
  const output = renderInlineMath(line, 30, stub);
  const rows = output.split("\n");
  assert.ok(rows.length > 1, `expected a wrap, got ${JSON.stringify(output)}`);
  for (const row of rows) {
    const width = row.replace(/\x1b_G[^;]*;[^\x1b]*\x1b\\/g, "").length;
    assert.ok(width <= 30, `row is ${width} columns wide: ${JSON.stringify(row)}`);
  }
  assert.equal(idsIn(output).length, 1, "the image must not be duplicated by the wrap");
});

test("an image is never split across rows", () => {
  const { stub } = stubRenderer(8);
  const output = renderInlineMath("word word $abcdefgh$ tail", 20, stub);
  // the image needs 8 of 20 columns: it fits on a row of its own
  for (const row of output.split("\n")) {
    const images = idsIn(row).length;
    assert.ok(images <= 1, `row carries ${images} images`);
  }
  assert.equal(idsIn(output).length, 1);
});

test("a formula wider than the line keeps its source", () => {
  const { stub } = stubRenderer(40);
  const markdown = "short $x$";
  assert.equal(renderInlineMath(markdown, 20, stub), markdown);
});

test("lines that already carry images and display math are skipped", () => {
  const { stub, requested } = stubRenderer();
  const markdown = [
    "\x1b[39m\x1b_Ga=T,f=100,q=2,t=f,c=3,r=1,C=1,i=7;AAAA\x1b\\   ",
    "$$",
    "x",
    "$$",
    "```",
    "$x$",
    "```",
  ].join("\n");
  assert.equal(renderInlineMath(markdown, 40, stub), markdown);
  assert.deepEqual(requested, []);
});

test("a render failure keeps the source line", () => {
  const stub = stubRenderer().stub;
  const refusing: InlineRenderer = { ...stub, cached: () => undefined, renderMissing: () => new Map() };
  const markdown = "value $x$ here";
  assert.equal(renderInlineMath(markdown, 40, refusing), markdown);
});

const visible = (text: string): string => text.replace(/\x1b_G[^;]*;[^\x1b]*\x1b\\/g, "<IMG>");

test("the line's block structure is parsed, not guessed", () => {
  assert.deepEqual(linePrefix("plain text"), {
    prefix: "",
    continuation: "",
    firstCols: 0,
    continuationCols: 0,
    code: false,
  });
  assert.deepEqual(linePrefix("  - item"), {
    prefix: "  - ",
    continuation: "    ",
    firstCols: 4,
    continuationCols: 4,
    code: false,
  });
  assert.deepEqual(linePrefix("> quote"), {
    prefix: "> ",
    continuation: "> ",
    firstCols: 2,
    continuationCols: 2,
    code: false,
  });
  assert.equal(linePrefix("    code").code, true);
  assert.equal(linePrefix("\tcode").code, false, "one tab is three columns, pi expands it");
  assert.equal(linePrefix(" \tcode").code, true);
});

test("indentation is kept once, not doubled", () => {
  const { stub } = stubRenderer(4);
  const output = renderInlineMath("  indented two spaces $x$", 30, stub);
  assert.ok(output.startsWith("  indented"), output);
  assert.ok(!output.startsWith("    "), `indentation doubled: ${JSON.stringify(output)}`);
  assert.equal(visible(output), "  indented two spaces <IMG>");
});

test("a list item's continuation rows line up with its text", () => {
  const { stub } = stubRenderer(4);
  const line = "- item with $x$ and some more words to force a wrap here";
  const output = renderInlineMath(line, 30, stub);
  const rows = output.split("\n");
  assert.ok(rows.length > 1, output);
  assert.ok(rows[0]!.startsWith("- item with "), rows[0]);
  for (const row of rows.slice(1)) {
    assert.ok(row.startsWith("  "), `continuation not aligned: ${JSON.stringify(row)}`);
    assert.ok(!row.startsWith("    "), `continuation over-indented: ${JSON.stringify(row)}`);
  }
});

test("a nested list item's continuation rows keep the item's column", () => {
  const { stub } = stubRenderer(4);
  const output = renderInlineMath("  - nested $x$ and more words to force a wrap here", 30, stub);
  for (const row of output.split("\n").slice(1)) {
    assert.ok(row.startsWith("    "), `continuation lost the nested column: ${JSON.stringify(row)}`);
  }
});

test("a wrapped blockquote keeps its marker on every row", () => {
  const { stub } = stubRenderer(4);
  const output = renderInlineMath("> quote with $x$ and many more words to force a wrap here", 34, stub);
  const rows = output.split("\n");
  assert.ok(rows.length > 1, output);
  for (const row of rows) {
    assert.ok(row.startsWith("> "), `quote marker lost: ${JSON.stringify(row)}`);
  }
  const nested = renderInlineMath("> > deep $x$ and many more words to force a wrap now", 34, stub);
  for (const row of nested.split("\n")) {
    assert.ok(row.startsWith("> > "), `nested quote marker lost: ${JSON.stringify(row)}`);
  }
});

test("an indented code block keeps its source", () => {
  const { stub, requested } = stubRenderer();
  const markdown = ["    a code line with $x$ in it", " \tanother with $y$"].join("\n");
  assert.equal(renderInlineMath(markdown, 40, stub), markdown);
  assert.deepEqual(requested, []);
  // a single tab is three columns, so it is still a paragraph
  const tabbed = renderInlineMath("\ttabbed $x$", 40, stub);
  assert.ok(tabbed.includes("\x1b_G"), tabbed);
});

test("the same formula is rendered once for several occurrences", () => {
  const { stub, requested } = stubRenderer();
  renderInlineMath("$x$ then $x$ again", 40, stub);
  assert.deepEqual(requested, [["x"]]);
  assert.equal(stub.cached({ latex: "x", display: "inline" } as FormulaRequest)?.path !== undefined, true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { fenceIntervals, findDisplayMathSpans, replaceDisplayMath } from "../src/transform.ts";

test("finds dollar and bracket display math", () => {
  assert.deepEqual(findDisplayMathSpans("$$x^2$$"), [
    { start: 0, end: 7, latex: "x^2", delimiter: "$$" },
  ]);
  assert.deepEqual(findDisplayMathSpans("\\[E = mc^2\\]"), [
    { start: 0, end: 12, latex: "E = mc^2", delimiter: "\\[" },
  ]);
});

test("multi-line blocks keep their body verbatim", () => {
  const markdown = "before\n\n$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n\nafter";
  const spans = findDisplayMathSpans(markdown);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].latex, "\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}");
});

test("closing delimiter must end its line, like pi's tokenizer", () => {
  assert.equal(findDisplayMathSpans("$$x^2$$ trailing").length, 0);
  assert.equal(findDisplayMathSpans("$$x^2 $$").length, 1);
  assert.equal(findDisplayMathSpans("$$x^2$$").length, 1);
});

test("inline math is left to pi's own renderer", () => {
  assert.equal(findDisplayMathSpans("the value $x^2$ is small").length, 0);
  assert.equal(findDisplayMathSpans("the value \\(x^2\\) is small").length, 0);
});

test("fenced code blocks are skipped", () => {
  const markdown = "```latex\n$$x^2$$\n```\n\n$$y^2$$\n";
  const spans = findDisplayMathSpans(markdown);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].latex, "y^2");

  const tildes = "~~~\n$$a$$\n~~~\n$$b$$\n";
  assert.equal(findDisplayMathSpans(tildes).length, 1);

  // An unclosed fence hides everything after it.
  assert.equal(findDisplayMathSpans("```\n$$a$$\n").length, 0);
});

test("indented fences still hide their contents", () => {
  const markdown = "  ```\n  $$a$$\n  ```\n$$b$$\n";
  const spans = findDisplayMathSpans(markdown);
  assert.deepEqual(spans.map((span) => span.latex), ["b"]);
});

test("multiple blocks are found in order and never overlap", () => {
  const markdown = "$$a$$\n\ntext\n\n\\[b\\]\n\n$$c$$\n";
  const spans = findDisplayMathSpans(markdown);
  assert.deepEqual(spans.map((span) => span.latex), ["a", "b", "c"]);
  for (let index = 1; index < spans.length; index += 1) {
    assert.ok(spans[index].start >= spans[index - 1].end);
  }
});

test("empty blocks are ignored", () => {
  assert.equal(findDisplayMathSpans("$$$$").length, 0);
  assert.equal(findDisplayMathSpans("$$\n   \n$$").length, 0);
});

test("fence intervals cover the whole block", () => {
  const markdown = "a\n```\nx\n```\nb\n";
  const intervals = fenceIntervals(markdown);
  assert.equal(intervals.length, 1);
  assert.equal(markdown.slice(intervals[0].start, intervals[0].end), "```\nx\n```");
});

test("replacements keep neighbouring text in separate paragraphs", () => {
  const markdown = "before\n$$x^2$$\nafter";
  const output = replaceDisplayMath(markdown, () => "ROW0\n\nROW1");
  assert.equal(output, "before\n\nROW0\n\nROW1\n\nafter");
});

test("replacements at the edges do not add stray blank lines", () => {
  assert.equal(replaceDisplayMath("$$x^2$$", () => "ROW"), "ROW");
  assert.equal(replaceDisplayMath("$$x^2$$\n", () => "ROW"), "ROW\n");
});

test("blocks that are not rendered keep their source", () => {
  const markdown = "before\n\n$$x^2$$\n\nafter";
  assert.equal(replaceDisplayMath(markdown, () => undefined), markdown);
});

test("only the failing block keeps its source", () => {
  const markdown = "$$a$$\n\n$$b$$";
  const output = replaceDisplayMath(markdown, (span) => (span.latex === "a" ? "A" : undefined));
  assert.equal(output, "A\n\n$$b$$");
});

test("replacement output remains one line per row", () => {
  const block = "ROW0\n\nROW1\n\nROW2";
  const output = replaceDisplayMath("text\n\n$$x$$\n\nmore", (span) =>
    span.latex === "x" ? block : undefined,
  );
  // Every rendered row sits on its own line; the count matches the row count.
  assert.equal(output.split("\n").filter((line) => line.startsWith("ROW")).length, 3);
  assert.ok(!output.includes("textROW"));
});

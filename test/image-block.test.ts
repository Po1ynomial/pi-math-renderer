import assert from "node:assert/strict";
import { test } from "node:test";
import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { buildImageBlock } from "../src/image-block.ts";

const identity = (text: string): string => text;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity,
  codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity,
  listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity,
};

const base = {
  path: "/tmp/formula.png",
  imageId: 0x11001d,
  availableCols: 60,
};

/** Render a block the way pi will, and report the resulting screen lines. */
function renderBlock(text: string, width = 60): string[] {
  return new Markdown(text, 0, 0, theme).render(width);
}

test("the block starts with the kitty command on an image line", () => {
  const block = buildImageBlock({ ...base, placement: { cols: 13, rows: 3 } });
  const first = block.text.split("\n")[0]!;
  assert.ok(first.startsWith("\x1b[39m"));
  assert.ok(first.includes("\x1b_Ga=T,f=100"));
  assert.ok(first.includes(",c=13,r=3,C=1,"));
});

test("centring spaces follow an escape so markdown sees no indented code block", () => {
  const block = buildImageBlock({ ...base, placement: { cols: 10, rows: 1 }, availableCols: 60 });
  const first = block.text.split("\n")[0]!;
  // 25 leading columns of centre in a 60 column area.
  assert.ok(first.startsWith("\x1b[39m" + " ".repeat(25)));
  for (const line of block.text.split("\n")) {
    assert.ok(!/^ {4}/.test(line), "no line may start with an indented code block");
  }
});

test("a rendered block occupies exactly as many lines as the image has rows", () => {
  // Regression: separating rows with blank lines made pi render an empty line
  // between them, cutting the image into bands (2 * rows - 1 lines).
  for (const rows of [1, 2, 3, 4, 7]) {
    const block = buildImageBlock({ ...base, placement: { cols: 12, rows } });
    const lines = renderBlock(block.text);
    assert.equal(lines.length, rows, `rows=${rows} rendered ${lines.length} lines`);
  }
});

test("only the first rendered line is an image line", () => {
  const block = buildImageBlock({ ...base, placement: { cols: 12, rows: 4 } });
  const lines = renderBlock(block.text);
  const imageLines = lines.filter((line) => line.includes("\x1b_G"));
  assert.equal(imageLines.length, 1);
  assert.ok(lines[0]!.includes("\x1b_G"));
  // Filler lines carry no visible glyphs, so following text cannot land inside
  // the image rectangle and the rows stay reserved.
  for (const line of lines.slice(1)) {
    assert.equal(line.replace(/[\x1b\u200b]/g, "").replace(/\[[0-9;]*m/g, "").trim(), "");
  }
});

test("filler lines are padded, keeping the image rectangle out of following text", () => {
  const block = buildImageBlock({ ...base, placement: { cols: 12, rows: 3 } });
  const lines = renderBlock(block.text);
  for (const line of lines.slice(1)) {
    assert.equal(visibleWidth(line), 60);
  }
});

test("neighbouring prose stays outside the image rectangle", () => {
  const block = buildImageBlock({ ...base, placement: { cols: 12, rows: 3 } });
  const lines = renderBlock(`before\n\n${block.text}\n\nafter`);
  const imageIndex = lines.findIndex((line) => line.includes("\x1b_G"));
  // "before", the blank line that separated it from the formula, then the image.
  assert.equal(imageIndex, 2);
  // Exactly `rows` lines belong to the image; prose resumes after the blank line
  // that separated the formula from it in the source.
  const rows = 3;
  assert.equal(lines[imageIndex + rows]!.trim(), "");
  assert.equal(lines[imageIndex + rows + 1]!.trim(), "after");
  // The image line is written verbatim; the filler rows after it are padded, so
  // they occupy the rectangle without extracting anything from it.
  assert.ok(visibleWidth(lines[imageIndex]!) <= 60);
  for (let offset = 1; offset < rows; offset += 1) {
    assert.equal(visibleWidth(lines[imageIndex + offset]!), 60);
  }
});

test("extreme placements stay renderable", () => {
  const block = buildImageBlock({ ...base, placement: { cols: 0, rows: 0 } });
  assert.deepEqual({ cols: block.cols, rows: block.rows }, { cols: 1, rows: 1 });
  assert.equal(renderBlock(block.text).length, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildContextSource,
  buildNodeSource,
  DEFAULT_MITEX_PACKAGE,
  mathCall,
  mitexImport,
  pagePrelude,
  sizePrelude,
  snapWrap,
  typstStringLiteral,
} from "../src/typst.ts";

test("typst string literals escape backslashes, quotes and newlines", () => {
  assert.equal(typstStringLiteral("x^2"), '"x^2"');
  assert.equal(typstStringLiteral("\\frac{1}{3}"), '"\\\\frac{1}{3}"');
  assert.equal(typstStringLiteral('say "hi"'), '"say \\"hi\\""');
  assert.equal(typstStringLiteral("a\nb"), '"a\\nb"');
});

test("mitex import is pinned and can be omitted", () => {
  assert.equal(mitexImport(), `#import "${DEFAULT_MITEX_PACKAGE}": mitex, mi\n`);
  assert.equal(mitexImport(""), "");
  assert.match(mitexImport("@preview/mitex:9.9.9"), /9\.9\.9/);
});

test("page prelude holds geometry and theme colour", () => {
  const prelude = pagePrelude("#e5e5e7");
  assert.match(prelude, /#set page\(width: auto, height: auto, margin: \(x: 0pt, y: 0pt\), fill: none\)/);
  assert.match(prelude, /#set text\(rgb\("#e5e5e7"\), top-edge: "ascender", bottom-edge: "descender"\)/);
  // Strokes follow the text colour so thick glyph rules stay visible.
  for (const element of ["line", "table", "circle", "ellipse", "curve", "polygon", "rect", "square"]) {
    assert.match(prelude, new RegExp(`#set ${element}\\(stroke: rgb\\("#e5e5e7"\\)\\)`));
  }
});

test("size prelude sets the baseline for text and math", () => {
  assert.equal(
    sizePrelude(11),
    "#set text(size: 11pt)\n#show math.equation: set text(size: 11pt)\n",
  );
  assert.match(sizePrelude(13.5), /13\.5pt/);
});

test("snapping wrapper rounds both axes to whole cells", () => {
  const { prefix, suffix } = snapWrap(11, 4.0333);
  assert.equal(prefix, "#context { let __it = [");
  assert.match(suffix, /let __mh = 11pt; let __mw = 4\.0333pt;/);
  assert.match(suffix, /calc\.ceil\(__d\.height \/ __mh - 0\.001\)/);
  assert.match(suffix, /calc\.ceil\(__d\.width \/ __mw - 0\.001\)/);
  assert.match(suffix, /block\(width: __tw, height: __th, align\(horizon, __it\)\)/);
});

test("single-row wrapper clips to one cell", () => {
  const { suffix } = snapWrap(11, 4.0333, 1);
  assert.match(suffix, /clip: true/);
  assert.match(suffix, /__rows <= 1\.5/);
});

test("math call selects the mitex entry point per display kind", () => {
  assert.equal(mathCall("x^2", "block"), '#mitex("x^2")');
  assert.equal(mathCall("x^2", "inline"), '#mi("x^2")');
  assert.equal(
    mathCall("x^2", "block", String.raw`\newcommand{\R}{\mathbb{R}}`),
    String.raw`#mitex("\\newcommand{\\R}{\\mathbb{R}}\nx^2")`,
  );
});

test("context document carries page setup, colour and import", () => {
  const context = buildContextSource("#e5e5e7");
  assert.match(context, new RegExp(`#import "${DEFAULT_MITEX_PACKAGE}"`));
  assert.match(context, /fill: none/);
  assert.match(context, /rgb\("#e5e5e7"\)/);
});

test("node document wraps the formula in a snapping context block", () => {
  const source = buildNodeSource({
    latex: "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
    display: "block",
    baselinePt: 11,
    cell: { widthPx: 11, heightPx: 30 },
  });
  assert.match(source, /^#import "@preview\/mitex:0\.2\.7": mitex, mi\n/);
  assert.match(source, /#set page\(width: auto, height: auto, margin: \(x: 0pt, y: 0pt\), fill: none\)/);
  assert.match(source, /#context \{ let __it = \[/);
  assert.match(source, /#set text\(size: 11pt\)/);
  assert.match(source, /#mitex\("\\\\int_0\^1 x\^2\\\\,dx = \\\\frac\{1\}\{3\}"\)/);
  assert.match(source, /align\(horizon, __it\)/);
});

test("node documents stay syntactically balanced", () => {
  const source = buildNodeSource({
    latex: "E = mc^2",
    display: "block",
    baselinePt: 11,
    cell: { widthPx: 9, heightPx: 18 },
  });
  assert.equal((source.match(/\[/g) ?? []).length, (source.match(/\]/g) ?? []).length);
  assert.equal((source.match(/\{/g) ?? []).length, (source.match(/\}/g) ?? []).length);
  assert.ok(source.trimEnd().endsWith("}"));
});

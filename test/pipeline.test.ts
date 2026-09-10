import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderEntry } from "../src/render.ts";
import { renderDisplayMath, type MarkdownContext, type MessageRenderer } from "../src/pipeline.ts";

const FORMULA = "\\int_0^1 x^2 \\, dx = \\frac{1}{3}";

/** Renderer stub: renders on demand into an in-memory "disk", never a service. */
function stubRenderer() {
  const entries = new Map<string, RenderEntry>();
  const requested: string[][] = [];
  const stub: MessageRenderer = {
    cached(latex) {
      return entries.get(latex);
    },
    placement() {
      return { cols: 13, rows: 3 };
    },
    renderMissing(latexSources) {
      requested.push([...latexSources]);
      const rendered = new Map<string, RenderEntry>();
      for (const latex of latexSources) {
        const index = entries.size;
        const entry: RenderEntry = {
          key: `key-${index}`,
          path: `/tmp/formula-${index}.png`,
          widthPx: 200,
          heightPx: 74,
        };
        entries.set(latex, entry);
        rendered.set(latex, entry);
      }
      return rendered;
    },
  };
  return { stub, requested, entries };
}

function context(overrides: Partial<MarkdownContext> = {}): MarkdownContext {
  return { messageType: "assistant", isStreaming: false, availableWidth: 113, ...overrides };
}

test("a closed block renders while the message is still streaming", () => {
  // Regression: the transformer used to bail out on `isStreaming`, so formulas
  // only appeared once the whole message had been delivered.
  const { stub } = stubRenderer();
  const markdown = `Working through it:\n\n$$\n${FORMULA}\n$$\n\nso the value is`;
  const output = renderDisplayMath(markdown, context({ isStreaming: true }), stub);
  assert.ok(output.includes("\x1b_Ga=T,f=100"), "streaming pass should emit an image line");
  assert.ok(!output.includes("\\frac{1}{3}"));
  assert.ok(output.includes("Working through it:"));
  assert.ok(output.includes("so the value is"));
});

test("a half-written block stays as source", () => {
  const { stub } = stubRenderer();
  const markdown = `$$\n\\begin{aligned}\n\\int_0^\\infty e^{-ax^2}\\,dx &= \\frac{1}{2} \\\\`;
  const output = renderDisplayMath(markdown, context({ isStreaming: true }), stub);
  assert.equal(output, markdown);
  assert.ok(!output.includes("\x1b_G"));
});

test("streaming and finalized messages render the same block", () => {
  const markdown = `$$\n${FORMULA}\n$$\n`;
  const streaming = renderDisplayMath(markdown, context({ isStreaming: true }), stubRenderer().stub);
  const finalized = renderDisplayMath(markdown, context(), stubRenderer().stub);
  // Image ids are per placement, so compare the shape, not the id.
  const shape = (text: string): string => text.replace(/i=\d+/g, "i=N");
  assert.equal(shape(streaming), shape(finalized));
});

test("every uncached formula is requested in a single batch", () => {
  const { stub, requested } = stubRenderer();
  const formulas = Array.from({ length: 7 }, (_, index) => `x^{${index}}`);
  const markdown = formulas.map((latex) => `$$\n${latex}\n$$`).join("\n\n");
  const output = renderDisplayMath(markdown, context(), stub);
  assert.deepEqual(requested, [formulas]);
  assert.equal([...output.matchAll(/\x1b_G/g)].length, 7, "all seven blocks should be images");
  assert.equal([...output.matchAll(/\x1b_G/g)].length, 7);
});

test("a repeated formula is rendered once and placed once per occurrence", () => {
  const { stub, requested } = stubRenderer();
  const markdown = `$$\n${FORMULA}\n$$\n\n$$\n${FORMULA}\n$$`;
  const output = renderDisplayMath(markdown, context(), stub);
  assert.deepEqual(requested, [[FORMULA]]);
  const ids = [...output.matchAll(/i=(\d+)/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test("a formula that cannot be rendered keeps its source", () => {
  const { stub } = stubRenderer();
  const refusing: MessageRenderer = { ...stub, renderMissing: () => new Map() };
  const markdown = `before\n\n$$\n${FORMULA}\n$$\n\nafter`;
  const output = renderDisplayMath(markdown, context(), refusing);
  assert.equal(output, markdown);
});

test("fenced code keeps its source even when it looks like display math", () => {
  const { stub, requested } = stubRenderer();
  const markdown = "```markdown\n$$\nx^2\n$$\n```\n";
  const output = renderDisplayMath(markdown, context(), stub);
  assert.equal(output, markdown);
  assert.deepEqual(requested, []);
});

test("markdown without display math is returned untouched", () => {
  const { stub, requested } = stubRenderer();
  const markdown = "just prose, with an inline $x$ and nothing else";
  assert.equal(renderDisplayMath(markdown, context(), stub), markdown);
  assert.deepEqual(requested, []);
});

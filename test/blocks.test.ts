import assert from "node:assert/strict";
import { test } from "node:test";
import { buildImageBlocks } from "../src/blocks.ts";
import { MAX_IMAGE_ID } from "../src/kitty.ts";
import type { RenderEntry } from "../src/render.ts";
import { findDisplayMathSpans, replaceDisplayMath } from "../src/transform.ts";

const FORMULA = "\\int_0^1 x^2 \\, dx = \\frac{1}{3}";

/** Renderer stub: one PNG per distinct LaTeX source, no service involved. */
function stubRenderer(cellRows = 3) {
  const entries = new Map<string, RenderEntry>();
  return {
    entries,
    cached(latex: string): RenderEntry | undefined {
      let entry = entries.get(latex);
      if (!entry) {
        const index = entries.size;
        entry = {
          key: `key-${index}`,
          path: `/tmp/formula-${index}.png`,
          widthPx: 200,
          heightPx: 74,
        };
        entries.set(latex, entry);
      }
      return entry;
    },
    placement(): { cols: number; rows: number } {
      return { cols: 20, rows: cellRows };
    },
  };
}

/** Image ids declared by the placements in a block. */
function idsIn(text: string): number[] {
  return [...text.matchAll(/i=(\d+)/g)].map((match) => Number.parseInt(match[1]!, 10));
}

function idsFor(markdown: string, renderer = stubRenderer()): number[] {
  const spans = findDisplayMathSpans(markdown);
  const blocks = buildImageBlocks(renderer, spans, 80);
  return [...blocks.values()].flatMap((text) => idsIn(text));
}

test("a formula repeated in one message gets one id per placement", () => {
  // Regression: ids were derived from the render key alone, so two placements
  // of the same formula shared one id. pi deletes images by id when it rewrites
  // a line, which removes every placement of that id, and only the rewritten
  // line is redrawn — so the other occurrence lost its image for good.
  const markdown = `$$\n${FORMULA}\n$$\n\n$$\n${FORMULA}\n$$\n`;
  const renderer = stubRenderer();
  const spans = findDisplayMathSpans(markdown);
  assert.equal(spans.length, 2);
  const blocks = buildImageBlocks(renderer, spans, 80);
  const ids = [...blocks.values()].flatMap((text) => idsIn(text));
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], "placements of one formula must not share an image id");
  // One render on disk still serves both placements.
  assert.equal(renderer.entries.size, 1);
  assert.equal([...blocks.values()][0], [...blocks.values()][0]);
});

test("separate transform runs never reuse an id", () => {
  // Two messages with identical text are separate placements too; ids must not
  // be a function of the source, or the second message destroys the first.
  const markdown = `$$\n${FORMULA}\n$$\n`;
  const first = idsFor(markdown);
  const second = idsFor(markdown);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0], second[0]);
});

test("ids stay in kitty's 32-bit range", () => {
  const markdown = Array.from({ length: 20 }, (_, index) => `$$\nx^{${index}}\n$$`).join("\n\n");
  for (const id of idsFor(markdown)) {
    assert.ok(id > 0 && id <= MAX_IMAGE_ID, `id out of range: ${id}`);
  }
});

test("blocks replace their span and keep the surrounding message", () => {
  const renderer = stubRenderer();
  const markdown = `before\n\n$$\n${FORMULA}\n$$\n\nafter\n`;
  const spans = findDisplayMathSpans(markdown);
  const blocks = buildImageBlocks(renderer, spans, 80);
  const output = replaceDisplayMath(markdown, (span) => blocks.get(span), spans);
  assert.ok(output.includes("before"));
  assert.ok(output.includes("after"));
  assert.ok(output.includes("\x1b_Ga=T,f=100"));
  assert.ok(!output.includes("\\frac{1}{3}"));
});

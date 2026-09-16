import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDisplayMath, type MarkdownContext } from "../src/pipeline.ts";
import type { FormulaPlacements, PlacedFormula } from "../src/render.ts";

const FORMULA = "\\int_0^1 x^2 \\, dx = \\frac{1}{3}";

/** Renderer stub: places every request, no service and no cache involved. */
function stubRenderer(rows = 3) {
  const requested: string[][] = [];
  const stub: FormulaPlacements = {
    placements(requests) {
      requested.push(requests.map((request) => request.latex));
      return requests.map(
        (request): PlacedFormula => ({
          key: `${request.display}:${request.latex}`,
          path: `/tmp/formula-${request.latex}.png`,
          cols: 13,
          rows,
        }),
      );
    },
  };
  return { stub, requested };
}

/** Renderer stub that refuses everything, the way a broken formula does. */
const refusing: FormulaPlacements = { placements: (requests) => requests.map(() => undefined) };

/**
 * Renderer stub whose display renders fail and whose inline renders succeed,
 * which is what a formula that typst rejects in block mode looks like: the
 * block key is remembered as failed while the inline key is still cold.
 */
const displayFails: FormulaPlacements = {
  placements: (requests) =>
    requests.map((request) =>
      request.display === "inline"
        ? { key: `inline:${request.latex}`, path: `/tmp/${request.latex}.png`, cols: 3, rows: 1 }
        : undefined,
    ),
};

function context(overrides: Partial<MarkdownContext> = {}): MarkdownContext {
  return { messageType: "assistant", isStreaming: false, availableWidth: 113, ...overrides };
}

/** Image ids declared by the placements in a message. */
function idsIn(text: string): number[] {
  return [...text.matchAll(/i=(\d+)/g)].map((match) => Number.parseInt(match[1]!, 10));
}

test("a streaming delta is skipped unless in-flight rendering is opted into", () => {
  const untouched: FormulaPlacements = {
    placements() {
      throw new Error("placements() must not be called for a skipped streaming delta");
    },
  };
  const markdown = `Working through it:\n\n$$\n${FORMULA}\n$$\n\nand inline $x^{2}$ too`;
  // Byte-identical, and no scan, layout, id allocation or service call.
  assert.equal(renderDisplayMath(markdown, context({ isStreaming: true }), untouched), markdown);
});

test("a streaming delta renders when in-flight rendering is enabled", () => {
  const { stub } = stubRenderer();
  const markdown = `Working through it:\n\n$$\n${FORMULA}\n$$\n\nso the value is`;
  const output = renderDisplayMath(markdown, context({ isStreaming: true }), stub, () => {}, {
    allowStreaming: true,
  });
  assert.ok(output.includes("\x1b_Ga=T,f=100"), "streaming pass should emit an image line");
  assert.ok(!output.includes("\\frac{1}{3}"));
  assert.ok(output.includes("Working through it:"));
  assert.ok(output.includes("so the value is"));
});

test("a finalized message renders with in-flight rendering off", () => {
  const { stub } = stubRenderer();
  const markdown = `$$\n${FORMULA}\n$$\n`;
  const output = renderDisplayMath(markdown, context(), stub, () => {}, { allowStreaming: false });
  assert.ok(output.includes("\x1b_Ga=T,f=100"), "message_end must still produce images");
  assert.ok(!output.includes("\\frac{1}{3}"));
});

test("a half-written block stays as source", () => {
  const { stub } = stubRenderer();
  const markdown = `$$\n\\begin{aligned}\n\\int_0^\\infty e^{-ax^2}\\,dx &= \\frac{1}{2} \\\\`;
  const output = renderDisplayMath(markdown, context({ isStreaming: true }), stub, () => {}, {
    allowStreaming: true,
  });
  assert.equal(output, markdown);
  assert.ok(!output.includes("\x1b_G"));
});

test("streaming and finalized messages render the same block", () => {
  const markdown = `$$\n${FORMULA}\n$$\n`;
  const streaming = renderDisplayMath(markdown, context({ isStreaming: true }), stubRenderer().stub, () => {}, {
    allowStreaming: true,
  });
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
});

test("a formula repeated in one message gets one id per placement", () => {
  // Regression: ids were derived from the render key alone, so two placements
  // of the same formula shared one id. pi deletes images by id when it rewrites
  // a line, which removes every placement of that id, and only the rewritten
  // line is redrawn, so the other occurrence lost its image for good.
  const { stub } = stubRenderer();
  const markdown = `$$\n${FORMULA}\n$$\n\n$$\n${FORMULA}\n$$\n`;
  const output = renderDisplayMath(markdown, context(), stub);
  const ids = idsIn(output);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], "placements of one formula must not share an image id");
});

test("separate transform runs never reuse an id", () => {
  // Two messages with identical text are separate placements too; ids must not
  // be a function of the source, or the second message destroys the first.
  const markdown = `$$\n${FORMULA}\n$$\n`;
  const first = idsIn(renderDisplayMath(markdown, context(), stubRenderer().stub));
  const second = idsIn(renderDisplayMath(markdown, context(), stubRenderer().stub));
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0], second[0]);
});

test("a formula that cannot be rendered keeps its source", () => {
  const markdown = `before\n\n$$\n${FORMULA}\n$$\n\nafter`;
  assert.equal(renderDisplayMath(markdown, context(), refusing), markdown);
});

test("a display block that could not be rendered keeps its source", () => {
  // Regression: the inline pass skipped lines beginning with `$$` but not lines
  // beginning with `\[`, so a single-line bracket block the display pass had
  // left alone was typeset as inline math instead of staying as source.
  const blocks = [`$$x^2$$\n`, `\\[x^2\\]\n`];
  for (const markdown of blocks) {
    assert.equal(renderDisplayMath(markdown, context(), refusing), markdown);
    assert.equal(renderDisplayMath(markdown, context(), displayFails), markdown);
  }
});

test("fenced code keeps its source even when it looks like display math", () => {
  const { stub, requested } = stubRenderer();
  const markdown = "```markdown\n$$\nx^2\n$$\n```\n";
  const output = renderDisplayMath(markdown, context(), stub);
  assert.equal(output, markdown);
  assert.deepEqual(requested, []);
});

test("markdown without math is returned untouched", () => {
  const { stub, requested } = stubRenderer();
  const markdown = "just prose, with no math at all";
  assert.equal(renderDisplayMath(markdown, context(), stub), markdown);
  assert.deepEqual(requested, []);
});

test("inline math becomes a one-row image inside its line", () => {
  const { stub } = stubRenderer();
  const markdown = "The value is $x^{2}$ here.";
  const output = renderDisplayMath(markdown, context(), stub);
  assert.ok(output.includes("\x1b_Ga=T,f=100"), "inline span should become an image");
  assert.ok(output.includes("\x1b_Ga=T,f=100,q=2,t=f,c=13,r=1,C=1"), "inline placement is one row tall");
  assert.ok(!output.includes("$x^{2}$"), "the source should be gone");
  assert.ok(output.startsWith("The value is "), output);
  assert.ok(output.endsWith(" here."), output);
});

test("inline math is rendered while the message is streaming when opted in", () => {
  const { stub } = stubRenderer();
  const output = renderDisplayMath("The value is $x^{2}$ here", context({ isStreaming: true }), stub, () => {}, {
    allowStreaming: true,
  });
  assert.ok(output.includes("\x1b_G"));
  assert.ok(!output.includes("$x^{2}$"));
});

test("inline math and display math in one message are both replaced", () => {
  const { stub } = stubRenderer();
  const markdown = "Inline $a^{2}$ then a block:\n\n$$\n${FORMULA}\n$$\n";
  const output = renderDisplayMath(markdown, context(), stub);
  assert.equal([...output.matchAll(/\x1b_G/g)].length, 2);
  assert.ok(!output.includes("$a^{2}$"));
  assert.ok(!output.includes("\\frac{1}{3}"));
});
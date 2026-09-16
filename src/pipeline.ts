/**
 * The markdown transformer's work, as a pure function.
 *
 * Scanning, rendering and replacement live in their own modules; this ties them
 * together so the pass can be tested with a stub renderer, without a service, a
 * terminal or pi's TUI runtime.
 *
 * Two passes run over every message: display math becomes one image block per
 * span, then inline math becomes one-row images inside their lines.
 */

import { buildImageBlock } from "./image-block.ts";
import { allocateImageId } from "./kitty.ts";
import { fitToWidth } from "./layout.ts";
import {
  type FormulaPlacements,
  type FormulaRequest,
  type PlacedFormula,
} from "./render.ts";
import { renderInlineMath } from "./inline.ts";
import { findDisplayMathSpans, replaceDisplayMath, type DisplayMathSpan } from "./transform.ts";

/** Columns that must stay available for a block, so it never triggers a wrap. */
const MIN_AVAILABLE_COLS = 8;

/** What pi tells the transformer about the Markdown it is rendering. */
export interface MarkdownContext {
  messageType: string;
  /** True while an assistant message is still being written. */
  isStreaming: boolean;
  availableWidth: number;
}

/** Transformer behaviour that is a choice rather than a fixed rule. */
export interface TransformOptions {
  /**
   * Experimental, off by default: transform while the assistant is still
   * writing. Off means a streaming delta is returned untouched, so nothing is
   * scanned, rendered or re-placed until `message_end` re-runs the transformer
   * with `isStreaming: false` (see `docs/extensions.md` in pi and the
   * `message_end` handler that calls `updateContent(message, false)`).
   */
  allowStreaming?: boolean;
  /**
   * The `--no-math-images` flag, read per call so a flag set for one run
   * disables rendering without unregistering anything. A disabled transformer
   * returns the message untouched, without scanning it.
   */
  disabled?: boolean;
}

/**
 * One markdown block per span, in source order.
 *
 * Every placement takes a fresh image id, which is why the blocks are built per
 * occurrence rather than per render. Deriving the id from the render key
 * instead would make repeated formulas share one id, and pi's delete-by-id then
 * erases every placement of that id while only redrawing the line it rewrote.
 */
function buildImageBlocks(
  placed: (PlacedFormula | undefined)[],
  spans: DisplayMathSpan[],
  availableCols: number,
  log: (message: string) => void,
): Map<DisplayMathSpan, string> {
  const blocks = new Map<DisplayMathSpan, string>();
  spans.forEach((span, index) => {
    const placement = placed[index];
    if (!placement) {
      log(`no placement for ${JSON.stringify(span.latex.slice(0, 40))}`);
      return;
    }
    const fitted = fitToWidth({ cols: placement.cols, rows: placement.rows }, availableCols);
    const block = buildImageBlock({
      path: placement.path,
      imageId: allocateImageId(),
      placement: fitted,
      availableCols,
    });
    const source = JSON.stringify(span.latex.slice(0, 60));
    log(
      `formula ${placement.key.slice(0, 8)} id=${block.imageId} -> ` +
        `${block.cols}x${block.rows} cells from ${source}`,
    );
    blocks.set(span, block.text);
  });
  return blocks;
}

/** Replace the display math in one message's markdown with image blocks. */
function renderDisplayPass(
  markdown: string,
  context: MarkdownContext,
  renderer: FormulaPlacements,
  availableCols: number,
  log: (message: string) => void,
): string {
  if (!markdown.includes("$$") && !markdown.includes("\\[")) return markdown;

  let spans: DisplayMathSpan[];
  try {
    spans = findDisplayMathSpans(markdown);
  } catch (error) {
    log(`scan failed: ${String(error)}`);
    return markdown;
  }
  if (spans.length === 0) return markdown;

  let blocks: Map<DisplayMathSpan, string>;
  try {
    const requests: FormulaRequest[] = spans.map((span) => ({ latex: span.latex, display: "block" }));
    blocks = buildImageBlocks(renderer.placements(requests), spans, availableCols, log);
  } catch (error) {
    log(`render failed: ${String(error)}`);
    return markdown;
  }
  log(
    `transform width=${context.availableWidth} streaming=${context.isStreaming} ` +
      `type=${context.messageType} spans=${spans.length} placed=${blocks.size}`,
  );
  if (blocks.size === 0) return markdown;

  try {
    return replaceDisplayMath(markdown, (span) => blocks.get(span), spans);
  } catch (error) {
    log(`replace failed: ${String(error)}`);
    return markdown;
  }
}

/**
 * Replace the display and inline math in one message's markdown with images.
 *
 * This is the transformer's whole contract: markdown in, markdown out, and
 * nothing throws. pi renders the message whatever a transformer returns, so a
 * failure of any kind, including one nobody anticipated, has to leave the
 * message as it was rather than half transformed.
 *
 * A streaming message is transformed only when `allowStreaming` is set: the
 * deltas otherwise cost a full scan and re-flow of the message plus a kitty
 * placement per formula per delta. Nothing half-written reaches typst either
 * way, because a span only matches once its closing delimiter is present (and,
 * for display math, at end of line).
 */
export function transformMessage(
  markdown: string,
  context: MarkdownContext,
  renderer: FormulaPlacements,
  log: (message: string) => void = () => {},
  options: TransformOptions = {},
): string {
  // Checked before anything else: a disabled or skipped message must not scan,
  // lay out, allocate ids, or block the frame on a cold render.
  if (options.disabled === true) return markdown;
  if (context.isStreaming && options.allowStreaming !== true) return markdown;

  const availableCols = Math.max(MIN_AVAILABLE_COLS, context.availableWidth);
  try {
    const display = renderDisplayPass(markdown, context, renderer, availableCols, log);
    try {
      return renderInlineMath(display, availableCols, renderer, log);
    } catch (error) {
      // The display blocks are already placed and still correct, so the inline
      // failure keeps them.
      log(`inline failed: ${String(error)}`);
      return display;
    }
  } catch (error) {
    // The logger is the caller's, and the contract holds even if it fails.
    try {
      log(`transform failed: ${String(error)}`);
    } catch {
      // Nothing left to report to.
    }
    return markdown;
  }
}

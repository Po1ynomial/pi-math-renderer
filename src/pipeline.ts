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

import { buildImageBlocks, type PlacementLookup } from "./blocks.ts";
import { renderInlineMath } from "./inline.ts";
import type { FormulaRequest, RenderEntry } from "./render.ts";
import { findDisplayMathSpans, replaceDisplayMath, type DisplayMathSpan } from "./transform.ts";

/** Columns that must stay available for a block, so it never triggers a wrap. */
export const MIN_AVAILABLE_COLS = 8;

/** The part of `FormulaRenderer` the passes need. */
export interface MessageRenderer extends PlacementLookup {
  /** Render the uncached formulas; returns the entries that became available. */
  renderMissing(requests: FormulaRequest[]): Map<string, RenderEntry>;
}

/** What pi tells the transformer about the Markdown it is rendering. */
export interface MarkdownContext {
  messageType: string;
  /** True while an assistant message is still being written. */
  isStreaming: boolean;
  availableWidth: number;
}

/** Replace the display math in one message's markdown with image blocks. */
function renderDisplayPass(
  markdown: string,
  context: MarkdownContext,
  renderer: MessageRenderer,
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
    const uncached = spans
      .map((span): FormulaRequest => ({ latex: span.latex, display: "block" }))
      .filter(
        (request, index, all) =>
          all.findIndex((candidate) => candidate.latex === request.latex) === index &&
          !renderer.cached(request),
      );
    if (uncached.length > 0) {
      const rendered = renderer.renderMissing(uncached);
      log(`rendered ${rendered.size}/${uncached.length} formula(s)`);
    }
    blocks = buildImageBlocks(renderer, spans, availableCols, log);
  } catch (error) {
    log(`render failed: ${String(error)}`);
    return markdown;
  }
  log(
    `transform width=${context.availableWidth} streaming=${context.isStreaming} ` +
      `type=${context.messageType} spans=${spans.length} emitted=${blocks.size}`,
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
 * Streaming messages are included: a formula becomes an image on the delta that
 * closes it, rather than only when the message is finished. Nothing
 * half-written reaches typst, because a span only matches once its closing
 * delimiter is present (and, for display math, at end of line).
 */
export function renderDisplayMath(
  markdown: string,
  context: MarkdownContext,
  renderer: MessageRenderer,
  log: (message: string) => void = () => {},
): string {
  const availableCols = Math.max(MIN_AVAILABLE_COLS, context.availableWidth);
  const display = renderDisplayPass(markdown, context, renderer, availableCols, log);
  try {
    return renderInlineMath(display, availableCols, renderer, log);
  } catch (error) {
    log(`inline failed: ${String(error)}`);
    return display;
  }
}

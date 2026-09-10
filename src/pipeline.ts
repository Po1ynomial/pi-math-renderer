/**
 * The markdown transformer's work, as a pure function.
 *
 * Scanning, rendering and replacement live in their own modules; this ties them
 * together so the pass can be tested with a stub renderer, without a service, a
 * terminal or pi's TUI runtime.
 */

import { buildImageBlocks, type BlockRenderer } from "./blocks.ts";
import type { RenderEntry } from "./render.ts";
import { findDisplayMathSpans, replaceDisplayMath, type DisplayMathSpan } from "./transform.ts";

/** Columns that must stay available for a block, so it never triggers a wrap. */
export const MIN_AVAILABLE_COLS = 8;

/** The part of `FormulaRenderer` the pass needs. */
export interface MessageRenderer extends BlockRenderer {
  /** Render the uncached formulas; returns the entries that became available. */
  renderMissing(latexSources: string[]): Map<string, RenderEntry>;
}

/** What pi tells the transformer about the Markdown it is rendering. */
export interface MarkdownContext {
  messageType: string;
  /** True while an assistant message is still being written. */
  isStreaming: boolean;
  availableWidth: number;
}

/**
 * Replace the display math in one message's markdown with image blocks.
 *
 * Streaming messages are included: a `$$…$$` block becomes an image on the
 * delta that closes it, rather than only when the message is finished. Nothing
 * half-written reaches typst, because a block only matches once its closing
 * delimiter is at end of line.
 */
export function renderDisplayMath(
  markdown: string,
  context: MarkdownContext,
  renderer: MessageRenderer,
  log: (message: string) => void = () => {},
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

  const availableCols = Math.max(MIN_AVAILABLE_COLS, context.availableWidth);
  let blocks: Map<DisplayMathSpan, string>;
  try {
    const uncached = spans
      .map((span) => span.latex)
      .filter((latex, index, all) => all.indexOf(latex) === index && !renderer.cached(latex));
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

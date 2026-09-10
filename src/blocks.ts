/**
 * One markdown block per display-math span.
 *
 * Kept apart from the extension wiring so block assembly and image-id policy
 * can be tested against the real span scanner, without pulling in pi's TUI
 * runtime or the render service.
 */

import { buildImageBlock } from "./image-block.ts";
import { allocateImageId } from "./kitty.ts";
import { fitToWidth, type CellPlacement } from "./layout.ts";
import type { FormulaRequest, RenderEntry } from "./render.ts";
import type { DisplayMathSpan } from "./transform.ts";

/** The part of `FormulaRenderer` that turning a cache hit into a placement needs. */
export interface PlacementLookup {
  /** Cache lookup only; never touches the render service. */
  cached(request: FormulaRequest): RenderEntry | undefined;
  /** Cell placement for a cached entry, for the current terminal. */
  placement(entry: RenderEntry): CellPlacement;
}

/**
 * Build one block per span, in source order.
 *
 * Rendering is the caller's job (`FormulaRenderer.renderMissing` batches the
 * uncached formulas); this only turns cache hits into markdown.
 *
 * Every placement takes a fresh image id. Deriving the id from the render key
 * instead would make repeated formulas share one id, and pi's delete-by-id then
 * erases every placement of that id while only redrawing the line it rewrote.
 */
export function buildImageBlocks(
  renderer: PlacementLookup,
  spans: DisplayMathSpan[],
  availableCols: number,
  log: (message: string) => void = () => {},
): Map<DisplayMathSpan, string> {
  const blocks = new Map<DisplayMathSpan, string>();
  for (const span of spans) {
    const entry = renderer.cached({ latex: span.latex, display: "block" });
    if (!entry) {
      log(`no image for ${JSON.stringify(span.latex.slice(0, 40))} (cache miss)`);
      continue;
    }
    const placement = fitToWidth(renderer.placement(entry), availableCols);
    const block = buildImageBlock({
      path: entry.path,
      imageId: allocateImageId(),
      placement,
      availableCols,
    });
    const source = JSON.stringify(span.latex.slice(0, 60));
    log(`formula ${entry.key.slice(0, 8)} id=${block.imageId} -> ${block.cols}x${block.rows} cells from ${source}`);
    blocks.set(span, block.text);
  }
  return blocks;
}

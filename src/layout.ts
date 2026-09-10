/**
 * Cell geometry for image placement.
 *
 * Ported from math-conceal.nvim's `grid.natural_dimensions` and the rendering
 * size math in `state.lua`. The invariants:
 *
 * - formulas are rendered at a ppi chosen so the configured baseline is exactly
 *   one terminal cell tall, and
 * - typst snaps the formula box to whole cells, so the PNG is always an exact
 *   multiple of the cell grid.
 *
 * Together those make `px -> cells` exact rather than approximate.
 */

/** Sane bound for a cell span, so a bad report cannot ask for a giant placement. */
export const MAX_SPAN = 4096;

/** Clamp a cell span into a sane range. */
export function clampSpan(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_SPAN, Math.floor(value)));
}

/** Pixel size of one terminal cell. Mirrors pi-tui's `CellDimensions`. */
export interface CellSize {
  widthPx: number;
  heightPx: number;
}

/** Placement of an image in terminal cells. */
export interface CellPlacement {
  cols: number;
  rows: number;
}

/** pi-tui's fallback when the terminal does not report pixel sizes. */
export const DEFAULT_CELL_SIZE: CellSize = { widthPx: 9, heightPx: 18 };

/** Default typst baseline. Matches math-conceal's `math_baseline_pt`. */
export const DEFAULT_BASELINE_PT = 11;

/** Sanitise a cell size, falling back per-axis to the pi-tui defaults. */
export function normalizeCellSize(cell: Partial<CellSize> | undefined): CellSize {
  const widthPx = Number(cell?.widthPx);
  const heightPx = Number(cell?.heightPx);
  return {
    widthPx: Number.isFinite(widthPx) && widthPx > 0 ? widthPx : DEFAULT_CELL_SIZE.widthPx,
    heightPx: Number.isFinite(heightPx) && heightPx > 0 ? heightPx : DEFAULT_CELL_SIZE.heightPx,
  };
}

/**
 * Rendering ppi that maps `baselinePt` onto exactly one cell height.
 *
 * `state.refresh_cell_px_size` in math-conceal computes the same value from the
 * tty winsize ioctl; pi-tui already queries the terminal, so we only redo the
 * arithmetic.
 */
export function renderPpi(cell: CellSize, baselinePt = DEFAULT_BASELINE_PT): number {
  const safe = normalizeCellSize(cell);
  const baseline = baselinePt > 0 ? baselinePt : DEFAULT_BASELINE_PT;
  return Math.max(72, Math.round((safe.heightPx * 72) / baseline));
}

/** Cell width expressed in points, used by the typst snapping wrapper. */
export function cellWidthPt(cell: CellSize, baselinePt = DEFAULT_BASELINE_PT): number {
  const safe = normalizeCellSize(cell);
  const baseline = baselinePt > 0 ? baselinePt : DEFAULT_BASELINE_PT;
  return baseline * (safe.widthPx / safe.heightPx);
}

/** Convert rendered pixels to whole cells. */
export function naturalCells(widthPx: number, heightPx: number, cell: CellSize): CellPlacement {
  const safe = normalizeCellSize(cell);
  const width = Math.max(1, Number.isFinite(widthPx) ? widthPx : 1);
  const height = Math.max(1, Number.isFinite(heightPx) ? heightPx : 1);
  return {
    cols: clampSpan(Math.max(1, Math.round(width / safe.widthPx))),
    rows: clampSpan(Math.max(1, Math.round(height / safe.heightPx))),
  };
}

/**
 * Fit a placement into `maxCols`, preserving the cell aspect ratio.
 *
 * Kitty scales the image into the virtual placement rectangle, so shrinking the
 * rectangle is enough; no re-render is required.
 */
export function fitToWidth(placement: CellPlacement, maxCols: number): CellPlacement {
  const limit = Math.max(1, Math.floor(maxCols));
  const cols = clampSpan(placement.cols);
  const rows = clampSpan(placement.rows);
  if (cols <= limit) return { cols, rows };
  const scale = limit / cols;
  return {
    cols: clampSpan(limit),
    rows: clampSpan(Math.max(1, Math.round(rows * scale))),
  };
}

/** Number of leading blank cells that centre `cols` inside `availableCols`. */
export function centerPrefixCols(cols: number, availableCols: number): number {
  const available = Math.max(0, Math.floor(availableCols));
  const width = clampSpan(cols);
  if (width >= available) return 0;
  return Math.max(0, Math.floor((available - width) / 2));
}

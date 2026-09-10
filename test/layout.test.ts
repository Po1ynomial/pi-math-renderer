import assert from "node:assert/strict";
import { test } from "node:test";
import {
  centerPrefixCols,
  DEFAULT_BASELINE_PT,
  DEFAULT_CELL_SIZE,
  fitToWidth,
  MAX_SPAN,
  naturalCells,
  normalizeCellSize,
  renderPpi,
  cellWidthPt,
} from "../src/layout.ts";

test("cell size falls back per axis", () => {
  assert.deepEqual(normalizeCellSize(undefined), DEFAULT_CELL_SIZE);
  assert.deepEqual(normalizeCellSize({ widthPx: 11 }), { widthPx: 11, heightPx: 18 });
  assert.deepEqual(normalizeCellSize({ widthPx: 0, heightPx: -3 }), DEFAULT_CELL_SIZE);
  assert.deepEqual(normalizeCellSize({ widthPx: Number.NaN, heightPx: 30 }), {
    widthPx: 9,
    heightPx: 30,
  });
});

test("ppi maps the baseline onto exactly one cell height", () => {
  // A 30px cell with an 11pt baseline: 11pt at 196ppi is 30px.
  assert.equal(renderPpi({ widthPx: 11, heightPx: 30 }, 11), 196);
  assert.equal(Math.round((11 * renderPpi({ widthPx: 11, heightPx: 30 }, 11)) / 72), 30);
  // Without a terminal query pi-tui reports 9x18, which is still self-consistent.
  assert.equal(renderPpi(DEFAULT_CELL_SIZE, DEFAULT_BASELINE_PT), 118);
  assert.equal(renderPpi({ widthPx: 9, heightPx: 18 }, 0), renderPpi(DEFAULT_CELL_SIZE));
});

test("cell width in points follows the cell aspect ratio", () => {
  assert.equal(cellWidthPt({ widthPx: 11, heightPx: 30 }, 11), 11 * (11 / 30));
});

test("pixels convert to whole cells", () => {
  const cell = { widthPx: 11, heightPx: 30 };
  // The typst wrapper snaps the box to cells, so the division is exact.
  assert.deepEqual(naturalCells(132, 30, cell), { cols: 12, rows: 1 });
  assert.deepEqual(naturalCells(132, 90, cell), { cols: 12, rows: 3 });
  assert.deepEqual(naturalCells(1, 1, cell), { cols: 1, rows: 1 });
  assert.deepEqual(naturalCells(Number.NaN, 30, cell), { cols: 1, rows: 1 });
});

test("placements shrink proportionally when the width is limited", () => {
  assert.deepEqual(fitToWidth({ cols: 12, rows: 3 }, 100), { cols: 12, rows: 3 });
  assert.deepEqual(fitToWidth({ cols: 12, rows: 4 }, 6), { cols: 6, rows: 2 });
  assert.deepEqual(fitToWidth({ cols: 12, rows: 4 }, 1), { cols: 1, rows: 1 });
  assert.deepEqual(fitToWidth({ cols: 0, rows: 0 }, 10), { cols: 1, rows: 1 });
});

test("cell spans are bounded", () => {
  assert.equal(naturalCells(MAX_SPAN * 100, 10, DEFAULT_CELL_SIZE).cols, MAX_SPAN);
  assert.equal(fitToWidth({ cols: MAX_SPAN, rows: MAX_SPAN }, MAX_SPAN).rows, MAX_SPAN);
});

test("blocks are centred with whole-cell prefixes", () => {
  assert.equal(centerPrefixCols(10, 20), 5);
  assert.equal(centerPrefixCols(10, 21), 5);
  assert.equal(centerPrefixCols(20, 10), 0);
  assert.equal(centerPrefixCols(1, 0), 0);
});

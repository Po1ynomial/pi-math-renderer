/**
 * Typst documents handed to the render service.
 *
 * Ported from math-conceal.nvim `lua/math-conceal/image/wrapper.lua` and the
 * colorscheme styling prelude in `lua/math-conceal/image/init.lua`. A formula is
 * rendered from two documents:
 *
 * - the context document, which installs page geometry, theme colours and the
 *   MiTeX import once for the whole compile
 * - the node document, which wraps a single formula in a `#context` block that
 *   measures it and snaps the box to whole terminal cells
 *
 * The snapping is what makes `widthPx / cellWidthPx` an exact integer, so cell
 * placement never drifts by a row or column.
 */

import { cellWidthPt, DEFAULT_BASELINE_PT, type CellSize, normalizeCellSize } from "./layout.ts";

/** MiTeX package version pinned by math-conceal.nvim. */
export const DEFAULT_MITEX_PACKAGE = "@preview/mitex:0.2.7";

/** How a formula should be typeset. */
export type MathDisplay = "block" | "inline";

export interface TypstDocumentOptions {
  /** LaTeX source without delimiters. */
  latex: string;
  /** Baseline in points; one baseline equals one cell height. */
  baselinePt?: number;
  /** Terminal cell size in pixels. */
  cell?: CellSize;
  /** Extra LaTeX macro definitions prepended to the formula body. */
  preamble?: string;
  /** MiTeX package specifier, or an empty string to omit MiTeX. */
  mitexPackage?: string;
}

/** Format a number as a typst point value. */
function pt(value: number): string {
  return `${Number(value.toFixed(4))}pt`;
}

/** Quote and escape a value for a typst string literal. */
export function typstStringLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

/** `#import` line bringing MiTeX's LaTeX (`mitex`) and inline (`mi`) entry points in scope. */
export function mitexImport(mitexPackage = DEFAULT_MITEX_PACKAGE): string {
  if (!mitexPackage) return "";
  return `#import "${mitexPackage}": mitex, mi\n`;
}

/**
 * Page and text setup for auto-sized formula pages.
 *
 * `fill: none` keeps the background transparent so the terminal background (and
 * pi's message background) shows through. The ascender/descender edges make the
 * text box match the line box, which keeps baselines stable.
 */
export function pagePrelude(colorHex: string): string {
  const color = `rgb("${colorHex}")`;
  return (
    "#set page(width: auto, height: auto, margin: (x: 0pt, y: 0pt), fill: none)\n" +
    `#set text(${color}, top-edge: "ascender", bottom-edge: "descender")\n` +
    `#set line(stroke: ${color})\n` +
    `#set table(stroke: ${color})\n` +
    `#set circle(stroke: ${color})\n` +
    `#set ellipse(stroke: ${color})\n` +
    `#set curve(stroke: ${color})\n` +
    `#set polygon(stroke: ${color})\n` +
    `#set rect(stroke: ${color})\n` +
    `#set square(stroke: ${color})\n`
  );
}

/** Baseline sizing preamble applied inside a formula node. */
export function sizePrelude(baselinePt = DEFAULT_BASELINE_PT): string {
  return (
    `#set text(size: ${pt(baselinePt)})\n` +
    `#show math.equation: set text(size: ${pt(baselinePt)})\n`
  );
}

/**
 * `#context` wrapper that measures the formula and rounds it up to whole cells.
 *
 * A single-cell-tall formula uses the clipped variant so tall glyphs cannot
 * bleed into the next line; taller formulas grow to the next whole cell row.
 */
export function snapWrap(
  baselinePt: number,
  cellWidthPoints: number,
  contentRows: 1 | "auto" = "auto",
): { prefix: string; suffix: string } {
  const rowHeight = pt(baselinePt);
  const cellWidth = pt(cellWidthPoints);
  const measure =
    `]; let __d = measure(__it); let __mh = ${rowHeight}; let __mw = ${cellWidth};`;
  if (contentRows === 1) {
    return {
      prefix: "#context { let __it = [",
      suffix:
        `${measure} let __rows = __d.height / __mh;` +
        " if __rows <= 1.5 { block(width: __d.width, height: __mh, clip: true, align(horizon, __it)) }" +
        " else { let __r = calc.max(1, calc.ceil(__rows - 0.001));" +
        " block(width: __d.width, height: __r * __mh, align(horizon, __it)) } }\n",
    };
  }
  return {
    prefix: "#context { let __it = [",
    suffix:
      `${measure} let __rows = calc.max(1, calc.ceil(__d.height / __mh - 0.001));` +
      " let __cols = calc.max(1, calc.ceil(__d.width / __mw - 0.001));" +
      " let __th = __rows * __mh; let __tw = __cols * __mw;" +
      " block(width: __tw, height: __th, align(horizon, __it)) }\n",
  };
}

/** MiTeX call for a formula body. */
export function mathCall(latex: string, display: MathDisplay, preamble = ""): string {
  const body = preamble ? `${preamble}\n${latex}` : latex;
  const fn = display === "block" ? "mitex" : "mi";
  return `#${fn}(${typstStringLiteral(body)})`;
}

/**
 * Context document for a compile request: page setup, theme colours and imports.
 */
export function buildContextSource(
  colorHex: string,
  options: { mitexPackage?: string; header?: string } = {},
): string {
  const parts = [options.header ?? "", pagePrelude(colorHex), mitexImport(options.mitexPackage)];
  return parts.filter(Boolean).join("");
}

/**
 * Node document for one formula, sent inline as a virtual file.
 *
 * Display math always uses the snapping wrapper so both axes land on cell
 * boundaries; inline math (v2) additionally clips to one cell.
 */
export function buildNodeSource(
  options: TypstDocumentOptions & { display: MathDisplay },
): string {
  const baselinePt = options.baselinePt ?? DEFAULT_BASELINE_PT;
  const cell = normalizeCellSize(options.cell);
  const { prefix, suffix } = snapWrap(
    baselinePt,
    cellWidthPt(cell, baselinePt),
    options.display === "inline" ? 1 : "auto",
  );
  return (
    mitexImport(options.mitexPackage) +
    "#set page(width: auto, height: auto, margin: (x: 0pt, y: 0pt), fill: none)\n" +
    prefix +
    "\n" +
    sizePrelude(baselinePt) +
    mathCall(options.latex, options.display, options.preamble) +
    "\n" +
    suffix
  );
}

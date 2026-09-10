/**
 * Assembly of the markdown block that displays one formula.
 *
 * The block is a single image line followed by blank filler lines:
 *
 * ```
 * <cursor reset><centring spaces><kitty display command>
 * <blank>
 * <blank>
 * ```
 *
 * The first line contains an escape sequence, so pi treats it as an "image
 * line": it is written verbatim, without wrapping or padding, and the image is
 * drawn from the cursor position for the whole `rows` cell rectangle. The filler
 * lines occupy that rectangle so following content cannot land inside it.
 *
 * Two details are load-bearing:
 *
 * - Rows are blank lines rather than one line per image row. pi renders one
 *   markdown paragraph per line and inserts an empty line between consecutive
 *   paragraphs, which would cut the image into bands.
 * - The centring spaces come *after* a reset escape. A line whose first
 *   character is a space is indented by four or more columns here, and markdown
 *   would read it as an indented code block, adding a code fence and shifting
 *   the image.
 */

import { displayCommand } from "./kitty.ts";
import { centerPrefixCols, type CellPlacement } from "./layout.ts";

/** Zero-width space: turns a filler line into a paragraph pi will render. */
const FILLER = "\u200b";
/** Reset escape in front of the centring spaces; invisible, keeps the line start non-blank. */
const LINE_HEAD = "\x1b[39m";

export interface ImageBlockInput {
  path: string;
  imageId: number;
  placement: CellPlacement;
  /** Columns available for the block, used for centring. */
  availableCols: number;
}

export interface ImageBlock {
  /** Markdown text to splice into the message. */
  text: string;
  cols: number;
  rows: number;
  /** Kitty image id this placement was built with. */
  imageId: number;
}

/**
 * Build the block for a formula.
 *
 * The rendered PNG is already an exact multiple of the cell grid, so the image
 * fills the declared rectangle without letterboxing or rescaling.
 */
export function buildImageBlock(input: ImageBlockInput): ImageBlock {
  const cols = Math.max(1, Math.floor(input.placement.cols));
  const rows = Math.max(1, Math.floor(input.placement.rows));
  const prefix = " ".repeat(centerPrefixCols(cols, input.availableCols));
  const head = LINE_HEAD + prefix + displayCommand(input.path, input.imageId, cols, rows);

  if (rows === 1) return { text: head, cols, rows, imageId: input.imageId };

  // The paragraph break after the image line already renders as one blank line,
  // so only `rows - 2` explicit filler lines are needed for a total of `rows`.
  const fillers = rows === 2 ? [] : Array.from({ length: rows - 2 }, () => FILLER);
  const text = fillers.length > 0 ? `${head}\n\n${fillers.join("\n")}` : `${head}\n\n`;
  return { text, cols, rows, imageId: input.imageId };
}

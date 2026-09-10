/**
 * Kitty graphics protocol primitives.
 *
 * The extension draws formulas with a plain placement: the image is transmitted
 * by file path and kitty scales it into the `c`x`r` cell rectangle declared in
 * the same command, which is exactly the shape pi's own `Image` component uses.
 *
 * A Unicode-placeholder grid (as math-conceal.nvim uses, because Neovim can move
 * individual cells around) was tried first and rejected: pi renders one markdown
 * paragraph per line, and consecutive paragraphs come out with an empty line
 * between them, which cuts a multi-row image into bands.
 */

/**
 * Largest image id this extension will emit.
 *
 * kitty's `i=` parameter is nominally 32-bit, but a *negative* value is dropped
 * without any response (`q=2` suppresses the error, so the placement just never
 * appears). Staying inside signed 32-bit keeps every id positive on every
 * kitty-protocol terminal, which matters because the old id path masked the
 * hash with `& 0xffffffff`: that wraps ids above 2^31 into negative numbers in
 * JavaScript, and those formulas silently stopped rendering.
 */
export const MAX_IMAGE_ID = 0x7fffffff;

/** Clamp an image id into the range kitty accepts, without wrapping signs. */
export function sanitiseImageId(imageId: number): number {
  if (!Number.isFinite(imageId)) return 1;
  const id = Math.floor(imageId);
  if (id < 1) return 1;
  return Math.min(id, MAX_IMAGE_ID);
}

/**
 * Kitty command that transmits a PNG by file path and displays it in a cell
 * rectangle.
 *
 * - `t=f` sends a path instead of the image bytes, so a redraw costs ~100 bytes
 *   rather than the whole PNG.
 * - `C=1` suppresses kitty's default cursor movement: the host, not the terminal,
 *   owns row accounting.
 */
export function displayCommand(path: string, imageId: number, cols: number, rows: number): string {
  const payload = Buffer.from(path, "utf8").toString("base64");
  const id = sanitiseImageId(imageId);
  return (
    `\x1b_Ga=T,f=100,q=2,t=f,c=${Math.max(1, Math.floor(cols))}` +
    `,r=${Math.max(1, Math.floor(rows))},C=1,i=${id};${payload}\x1b\\`
  );
}

/**
 * Allocate kitty image ids, one per placement.
 *
 * pi tracks images by the id found on a line: rewriting a line deletes that id,
 * and the deletion (`a=d,d=I,i=…`) removes *every* placement of the id. Two
 * placements sharing an id therefore destroy each other — the rewritten line is
 * redrawn, the other occurrence stays blank until something redraws it.
 *
 * That rules out deriving ids from the render key, however stable that is: a
 * formula repeated in one message, or in two messages, produces several
 * placements with the same key. Ids are allocated per placement instead.
 *
 * The counter starts at a random offset so a restarted pi process cannot reuse
 * ids that placements from an earlier process still hold in the scrollback, and
 * it stays inside the range kitty accepts (see `MAX_IMAGE_ID`).
 */
export function createImageIdAllocator(random: () => number = Math.random): () => number {
  const start = Math.floor(random() * MAX_IMAGE_ID);
  let next = Number.isFinite(start) && start >= 1 ? Math.min(start, MAX_IMAGE_ID - 1) : 1;
  return () => {
    next = next >= MAX_IMAGE_ID ? 1 : next + 1;
    return next;
  };
}

/** Process-wide allocator: every placement in this pi process gets its own id. */
export const allocateImageId = createImageIdAllocator();

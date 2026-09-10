/**
 * Theme colour for rendered formulas.
 *
 * Formula pixels are baked at render time, so the theme colour is part of the
 * render key: switching themes produces new PNGs instead of recolouring the old
 * ones.
 *
 * The colour comes from `ctx.ui.theme`, which pi re-points on theme changes.
 * Themes may express colours as truecolour SGR or as a 256-colour palette index,
 * so both encodings are decoded here.
 */

/** Used when the theme does not expose a usable text colour. */
const FALLBACK_DARK = "#e5e5e7";
const FALLBACK_LIGHT = "#000000";

/** Minimal theme surface needed for colour extraction. */
export interface ThemeLike {
  fg?: (color: "text", text: string) => string;
  getFgAnsi?: (color: "text") => string;
}

const SGR_TRUECOLOR = /\u001b\[38;2;(\d+);(\d+);(\d+)m/;
const SGR_PALETTE = /\u001b\[38;5;(\d+)m/;

const HEX = /^#[0-9a-fA-F]{6}$/;

function toHex(red: number, green: number, blue: number): string {
  const channel = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** xterm 256-colour palette entry as `#rrggbb`. */
export function ansi256ToHex(index: number): string {
  const value = Math.max(0, Math.min(255, Math.floor(index)));
  if (value < 16) {
    const basic = [
      [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
      [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
      [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
      [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ][value]!;
    return toHex(basic[0]!, basic[1]!, basic[2]!);
  }
  if (value < 232) {
    const offset = value - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const red = steps[Math.floor(offset / 36) % 6]!;
    const green = steps[Math.floor(offset / 6) % 6]!;
    const blue = steps[offset % 6]!;
    return toHex(red, green, blue);
  }
  const level = 8 + (value - 232) * 10;
  return toHex(level, level, level);
}

/** Decode a foreground SGR sequence into `#rrggbb`. */
export function parseAnsiForeground(sequence: string): string | undefined {
  const truecolor = SGR_TRUECOLOR.exec(sequence);
  if (truecolor) {
    return toHex(Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3]));
  }
  const palette = SGR_PALETTE.exec(sequence);
  if (palette) return ansi256ToHex(Number(palette[1]));
  return undefined;
}

/**
 * Read the text colour from a pi theme.
 *
 * `getFgAnsi` is preferred because it returns the escape sequence without
 * rendering a string; `fg` is the documented fallback.
 */
export function colorFromTheme(theme: ThemeLike | undefined): string {
  if (!theme) return defaultFormulaColor();
  try {
    const sequence = theme.getFgAnsi?.("text") ?? theme.fg?.("text", "\u0000") ?? "";
    const parsed = parseAnsiForeground(sequence);
    if (parsed && HEX.test(parsed)) return parsed;
  } catch {
    // Fall through to the theme-independent default.
  }
  return defaultFormulaColor();
}

/**
 * Colour used before a theme is available.
 *
 * pi initialises the theme during startup, so this only covers the window
 * between extension load and `session_start`.
 */
export function defaultFormulaColor(isLight = false): string {
  return isLight ? FALLBACK_LIGHT : FALLBACK_DARK;
}

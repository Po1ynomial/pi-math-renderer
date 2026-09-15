/**
 * pi-math-renderer
 *
 * Renders LaTeX display math in pi's markdown as kitty images.
 *
 * Flow: a markdown transformer finds `$$…$$` / `\[…\]` blocks, asks the
 * math-conceal render service for a PNG of each uncached formula, and replaces
 * the block with an image line (a kitty placement, transmitted by file path)
 * followed by blank filler lines that reserve the rest of the rectangle. pi's
 * markdown renderer treats lines containing a kitty escape sequence as opaque
 * "image lines", so the placement survives wrapping, scrolling and redraws.
 *
 * Everything except the transform is pure plumbing: key derivation, the on-disk
 * index, cell geometry, kitty command building and block assembly all live in
 * their own modules.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions } from "@earendil-works/pi-tui";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { renderDisplayMath } from "./pipeline.ts";
import { FormulaRenderer } from "./render.ts";
import { colorFromTheme, defaultFormulaColor } from "./theme.ts";

/**
 * Debug log sink.
 *
 * Diagnostics go to a file rather than stderr: pi owns the terminal while the
 * TUI runs, and any stray write would land in the middle of the rendered frame.
 */
function createLogger(enabled: boolean, file: string): (message: string) => void {
  if (!enabled) return () => {};
  return (message: string) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${message}\n`, "utf8");
    } catch {
      // Logging must never break rendering.
    }
  };
}

export interface Session {
  renderer: FormulaRenderer;
  config: Config;
  log: (message: string) => void;
}

/** Build the renderer for the current environment. */
export function createSession(colorHex: () => string = defaultFormulaColor): Session {
  const config = loadConfig();
  const cacheDir = join(getAgentDir(), "math-renderer");
  const log = createLogger(config.debug, join(cacheDir, "debug.log"));
  const renderer = new FormulaRenderer({
    serviceBinary: config.serviceBinary,
    cacheDir,
    root: process.cwd(),
    colorHex,
    baselinePt: config.baselinePt,
    cellSize: () => getCellDimensions(),
    ppi: config.ppi,
    timeoutMs: config.timeoutMs,
    log,
  });
  return { renderer, config, log };
}

export default function mathRenderer(pi: ExtensionAPI): void {
  /**
   * Live theme colour. The renderer reads it on every transform and pi
   * re-points `ctx.ui.theme` when the theme changes, so a theme switch costs one
   * re-render instead of leaving a stale image.
   */
  let colorProvider: () => string = () => defaultFormulaColor();
  const session = createSession(() => colorProvider());
  const { config, log } = session;

  pi.registerFlag("no-math-images", {
    description: "Disable LaTeX display math image rendering",
    type: "boolean",
  });

  pi.registerFlag("math-images-streaming", {
    description: "Experimental: render math while the message streams (quirky, off by default)",
    type: "boolean",
  });

  /**
   * In-flight rendering is opt-in from either the environment or the flag, and
   * off by default. Read per call: flags are stable, but this keeps the state
   * in one place for the status command and the transformer.
   */
  const streamingEnabled = (): boolean =>
    config.streaming || pi.getFlag("math-images-streaming") === true;

  pi.registerCommand("math-renderer", {
    description: "Show math image rendering status",
    handler: async (_args, ctx) => {
      const flagDisabled = pi.getFlag("no-math-images") === true;
      const state = config.enabled && !flagDisabled ? "on" : "off";
      const detail = config.disabledReason ? ` (${config.disabledReason})` : "";
      const service = config.serviceBinary ? config.serviceBinary.split("/").pop() : "not found";
      const streaming = config.enabled && streamingEnabled() ? "on" : "off";
      ctx.ui.notify(
        `math images ${state}${detail} · streaming ${streaming} (experimental) ·` +
          ` service ${service} · baseline ${config.baselinePt}pt`,
        "info",
      );
    },
  });

  if (!config.enabled) {
    log(`inactive: ${config.disabledReason}`);
    return;
  }
  const capabilities = getCapabilities();
  if (capabilities.images !== "kitty") {
    log(`inactive: terminal image protocol is ${capabilities.images ?? "unsupported"}`);
    return;
  }
  log(`active with ${config.serviceBinary}`);
  if (streamingEnabled()) log("streaming rendering enabled (experimental)");

  pi.on("session_start", (_event, ctx) => {
    colorProvider = () => config.color ?? colorFromTheme(ctx.ui.theme);
    log(`formula colour ${colorProvider()}`);
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    if (pi.getFlag("no-math-images") === true) return markdown;
    // pi contains a throw from a transformer, but the fallback should be the
    // untouched message, not whatever the pass had produced so far.
    try {
      return renderDisplayMath(markdown, context, session.renderer, log, {
        allowStreaming: streamingEnabled(),
      });
    } catch (error) {
      log(`transform failed: ${String(error)}`);
      return markdown;
    }
  });
}

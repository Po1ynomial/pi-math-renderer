/**
 * pi-math-renderer
 *
 * Renders LaTeX math in pi's markdown as kitty images.
 *
 * Flow: a markdown transformer finds `$$…$$` / `\[…\]` blocks, asks the
 * math-conceal render service for a PNG of each uncached formula, and replaces
 * the block with an image line (a kitty placement, transmitted by file path)
 * followed by blank filler lines that reserve the rest of the rectangle. pi's
 * markdown renderer treats lines containing a kitty escape sequence as opaque
 * "image lines", so the placement survives wrapping, scrolling and redraws.
 *
 * This module is the composition root and nothing else: it reads the
 * environment, builds one session, and registers the transformer, the flags and
 * the status command with pi. The transformer's behaviour lives in
 * `pipeline.ts`, so it can be tested without a TUI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, type TerminalCapabilities } from "@earendil-works/pi-tui";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import type { CellSize } from "./layout.ts";
import { transformMessage } from "./pipeline.ts";
import { FormulaRenderer } from "./render.ts";
import type { SpawnSyncFn } from "./service.ts";
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
  /** The colour formulas are rendered in: the configured one, else the theme's. */
  colorHex: () => string;
}

/**
 * What building a session needs from its environment.
 *
 * Every field defaults to the process environment, the agent directory, the
 * terminal and the real service, so production passes nothing. A test supplies
 * its own, which is the only way to reach this wiring without a TUI, a service
 * and a kitty terminal.
 */
export interface SessionEnvironment {
  /** Resolved configuration. */
  config?: Config;
  /** Directory for the PNGs and the index file. */
  cacheDir?: string;
  /** Working root reported to the service (used for relative imports). */
  root?: string;
  /** Terminal cell size. */
  cellSize?: () => CellSize;
  /** Theme text colour, re-pointed by pi when the theme changes. */
  themeColor?: () => string;
  /** Service process adapter. */
  spawnSync?: SpawnSyncFn;
}

/** The session's environment plus the terminal probe the extension gates on. */
export interface RendererEnvironment extends SessionEnvironment {
  /** Terminal capability probe. */
  capabilities?: () => Pick<TerminalCapabilities, "images">;
}

/** Build the renderer and the logger for the current environment. */
export function createSession(environment: SessionEnvironment = {}): Session {
  const config = environment.config ?? loadConfig();
  const cacheDir = environment.cacheDir ?? join(getAgentDir(), "math-renderer");
  const themeColor = environment.themeColor ?? (() => defaultFormulaColor());
  /** The configured colour wins over the theme's, for every render. */
  const colorHex = (): string => config.color ?? themeColor();
  const log = createLogger(config.debug, join(cacheDir, "debug.log"));
  const renderer = new FormulaRenderer({
    serviceBinary: config.serviceBinary,
    cacheDir,
    root: environment.root ?? process.cwd(),
    colorHex,
    baselinePt: config.baselinePt,
    cellSize: environment.cellSize ?? (() => getCellDimensions()),
    ppi: config.ppi,
    timeoutMs: config.timeoutMs,
    spawnSync: environment.spawnSync,
    log,
  });
  return { renderer, config, log, colorHex };
}

export default function mathRenderer(pi: ExtensionAPI, environment: RendererEnvironment = {}): void {
  /**
   * Live theme colour. The renderer reads it on every transform and pi
   * re-points this when the theme changes, so a theme switch costs one
   * re-render instead of leaving a stale image.
   */
  let themeColor = environment.themeColor ?? (() => defaultFormulaColor());
  const session = createSession({ ...environment, themeColor: () => themeColor() });
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
  const capabilities = (environment.capabilities ?? getCapabilities)();
  if (capabilities.images !== "kitty") {
    log(`inactive: terminal image protocol is ${capabilities.images ?? "unsupported"}`);
    return;
  }
  log(`active with ${config.serviceBinary}`);
  if (streamingEnabled()) log("streaming rendering enabled (experimental)");

  pi.on("session_start", (_event, ctx) => {
    themeColor = () => colorFromTheme(ctx.ui.theme);
    log(`formula colour ${session.colorHex()}`);
  });

  pi.registerMarkdownTransformer((markdown, context) =>
    transformMessage(markdown, context, session.renderer, log, {
      disabled: pi.getFlag("no-math-images") === true,
      allowStreaming: streamingEnabled(),
    }),
  );
}
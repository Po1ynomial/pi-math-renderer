/**
 * Configuration and environment guards.
 *
 * Everything is optional: with no configuration at all the extension enables
 * itself when the terminal supports kitty images and the render service binary
 * can be found.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BASELINE_PT, type CellSize } from "./layout.ts";
import { resolveServiceBinary } from "./service.ts";

export interface Config {
  /** False when `PI_MATH_RENDERER=0` or the TUI runs in fullscreen mode. */
  enabled: boolean;
  /** Reason rendering is disabled, for logging. */
  disabledReason?: string;
  /** Rendering service executable, if one was found. */
  serviceBinary?: string;
  baselinePt: number;
  /** Formula colour override; otherwise the theme's text colour. */
  color?: string;
  /** Explicit ppi override; otherwise derived from the cell size. */
  ppi?: number;
  timeoutMs?: number;
  /** Terminal cell size probe; injectable for tests. */
  cellSize?: () => CellSize;
  debug: boolean;
}

export interface ConfigEnvironment {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  home?: string;
  agentDir?: string;
  /** Read the persisted TUI mode; injectable for tests. */
  readSettings?: (path: string) => unknown;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return undefined;
}

/** Accept `#rrggbb` only; anything else falls back to the theme colour. */
function parseColor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** `tuiMode` as given on the command line, if present. */
export function tuiModeFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--tui-mode") {
      const value = argv[index + 1];
      if (value !== undefined) return value;
    } else if (argument.startsWith("--tui-mode=")) {
      return argument.slice("--tui-mode=".length);
    }
  }
  return undefined;
}

/** `tuiMode` persisted in settings.json, if present. */
export function tuiModeFromSettings(readSettings: (path: string) => unknown): string | undefined {
  try {
    const settings = readSettings(join(getAgentDir(), "settings.json"));
    if (settings && typeof settings === "object") {
      const mode = (settings as Record<string, unknown>).tuiMode;
      if (typeof mode === "string") return mode;
    }
  } catch {
    // Missing or unreadable settings mean the default (regular) mode.
  }
  return undefined;
}

function readSettingsFile(path: string): unknown {
  let stamp = 0;
  try {
    stamp = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  if (cachedSettings?.stamp === stamp) return cachedSettings.value;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    cachedSettings = { stamp, value };
    return value;
  } catch {
    cachedSettings = { stamp, value: undefined };
    return undefined;
  }
}

let cachedSettings: { stamp: number; value: unknown } | undefined;

/**
 * Resolve configuration.
 *
 * Fullscreen mode disables rendering: pi's alternate-screen renderer deletes
 * every placement on a frame that redraws any image (`deleteAllKittyPlacements`)
 * and then re-emits only the rows it considers changed, because it re-places
 * images from its own metadata registry rather than from the escape on the
 * line. An extension's placement is not in that registry, so markdown image
 * lines disappear there; display math is better left to pi's Unicode renderer.
 */
export function loadConfig(environment: ConfigEnvironment = {}): Config {
  const env = environment.env ?? process.env;
  const argv = environment.argv ?? process.argv.slice(2);
  const home = environment.home;
  const readSettings = environment.readSettings ?? readSettingsFile;

  const base: Config = {
    enabled: true,
    baselinePt: parseNumber(env.PI_MATH_RENDERER_BASELINE_PT) ?? DEFAULT_BASELINE_PT,
    color: parseColor(env.PI_MATH_RENDERER_COLOR),
    ppi: parseNumber(env.PI_MATH_RENDERER_PPI),
    timeoutMs: parseNumber(env.PI_MATH_RENDERER_TIMEOUT_MS),
    debug: parseBoolean(env.PI_MATH_RENDERER_DEBUG) === true,
    serviceBinary: resolveServiceBinary(undefined, env, home),
  };

  if (parseBoolean(env.PI_MATH_RENDERER) === false) {
    return { ...base, enabled: false, disabledReason: "disabled by PI_MATH_RENDERER" };
  }

  const tuiMode = tuiModeFromArgv(argv) ?? tuiModeFromSettings(readSettings);
  if (tuiMode === "fullscreen") {
    return { ...base, enabled: false, disabledReason: "fullscreen TUI mode is not supported" };
  }

  if (base.serviceBinary === undefined) {
    return {
      ...base,
      enabled: false,
      disabledReason: "typst-concealer-service not found (install the math-conceal-service rock)",
    };
  }

  return base;
}

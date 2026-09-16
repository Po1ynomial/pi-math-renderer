/**
 * Client for math-conceal.nvim's render service.
 *
 * The service is a line-delimited JSON process: write one request per line, read
 * one response line per rendered node. See `service/src/protocol.rs` upstream.
 *
 * One function is the whole conversation: formulas and geometry in, responses
 * out. The request shape and the response parsing are internals, because the
 * extension sends one request kind and has one thing to say about each node.
 *
 * Rendering runs through `spawnSync` rather than a long-lived child because pi's
 * markdown transformer is synchronous: the image has to exist by the time the
 * line is returned, otherwise later renders keep serving cached component lines
 * and the formula would stay as source text. A cold batch costs ~140 ms
 * regardless of node count, and previously rendered formulas never reach the
 * service at all thanks to the local index.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, isAbsolute } from "node:path";
import { homedir } from "node:os";

/** Default executable name installed by the `math-conceal-service` rock. */
export const SERVICE_BINARY_NAME = "typst-concealer-service";

/** One formula to render. */
export interface RenderNode {
  /** Stable identity of the rendered document; also names the output file. */
  nodeId: string;
  /** Typst document for this formula. */
  source: string;
}

/** One service response. */
export interface RenderedFormula {
  nodeId: string;
  status: "ok" | "error";
  path?: string;
  widthPx?: number;
  heightPx?: number;
  diagnostics: string[];
}

/** What a batch asks the service for, beyond the formulas themselves. */
export interface RenderBatchOptions {
  /** Rendering service executable. */
  binary: string;
  /** Typst context document, carrying the page setup and the formula colour. */
  contextSource: string;
  /** Working root for relative imports in the formulas. */
  root: string;
  /** Directory the rendered images are written to. */
  outputDir: string;
  /** Pixels per inch, derived from the cell geometry so one baseline is one cell. */
  ppi: number;
  /** How long the service may take before the batch is abandoned. */
  timeoutMs?: number;
}

/** Minimal `spawnSync` surface, so tests can inject a fake. */
export type SpawnSyncFn = (
  command: string,
  args: string[],
  options: { input: string; timeout: number; encoding: "utf8"; maxBuffer: number },
) => { status: number | null; stdout: string; stderr: string; error?: Error };

export class RenderServiceError extends Error {}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Protocol identity of the context document this client sends. */
const CONTEXT_ID = "pi-math-renderer";
/** Revision of that context document. The client builds one context per batch. */
const CONTEXT_REV = 1;
/** Workers the service renders a batch across. */
const WORKER_COUNT = 2;

const defaultSpawn: SpawnSyncFn = (command, args, options) => {
  try {
    const stdout = execFileSync(command, args, {
      input: options.input,
      timeout: options.timeout,
      encoding: options.encoding,
      maxBuffer: options.maxBuffer,
    });
    return { status: 0, stdout: String(stdout), stderr: "" };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: typeof failure.status === "number" ? failure.status : null,
      stdout: failure.stdout ? failure.stdout.toString() : "",
      stderr: failure.stderr ? failure.stderr.toString() : "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Parse service output lines into responses keyed by node id. */
function parseResponses(stdout: string): Map<string, RenderedFormula> {
  const responses = new Map<string, RenderedFormula>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof payload !== "object" || payload === null) continue;
    const record = payload as Record<string, unknown>;
    if (record.type !== "formula_rendered" || typeof record.node_id !== "string") continue;
    const status = record.status === "ok" ? "ok" : "error";
    const diagnostics: string[] = [];
    if (Array.isArray(record.diagnostics)) {
      for (const diagnostic of record.diagnostics) {
        if (typeof diagnostic === "string") {
          diagnostics.push(diagnostic);
        } else if (diagnostic && typeof diagnostic === "object") {
          const message = (diagnostic as Record<string, unknown>).message;
          if (typeof message === "string") diagnostics.push(message);
        }
      }
    }
    responses.set(record.node_id, {
      nodeId: record.node_id,
      status,
      path: typeof record.path === "string" ? record.path : undefined,
      widthPx: typeof record.width_px === "number" ? record.width_px : undefined,
      heightPx: typeof record.height_px === "number" ? record.height_px : undefined,
      diagnostics,
    });
  }
  return responses;
}

/** Build the request line for a batch. */
function buildRequest(nodes: RenderNode[], options: RenderBatchOptions): string {
  const request = {
    type: "render_formulas",
    request_id: `pi-math-renderer:${Date.now()}`,
    context_id: CONTEXT_ID,
    context_rev: CONTEXT_REV,
    context_source: options.contextSource,
    root: options.root,
    inputs: {},
    output_dir: options.outputDir,
    ppi: Math.max(1, Math.round(options.ppi)),
    worker_count: WORKER_COUNT,
    nodes: nodes.map((node) => ({
      node_id: node.nodeId,
      node_rev: 1,
      kind: "math",
      source: node.source,
    })),
  };
  return `${JSON.stringify(request)}\n`;
}

/**
 * Render a batch of formulas.
 *
 * Throws {@link RenderServiceError} when the service cannot run at all; per-node
 * failures come back as `status: "error"` responses instead. Responses come back
 * in request order, with a synthetic error for a node the service did not
 * mention.
 */
export function renderBatch(
  nodes: RenderNode[],
  options: RenderBatchOptions,
  spawnSync: SpawnSyncFn = defaultSpawn,
): RenderedFormula[] {
  if (nodes.length === 0) return [];
  const result = spawnSync(options.binary, [], {
    input: buildRequest(nodes, options),
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const responses = parseResponses(result.stdout ?? "");
  if (responses.size === 0) {
    const detail = result.error?.message ?? (result.stderr ?? "").trim();
    throw new RenderServiceError(
      `render service produced no output${detail ? `: ${detail}` : ""}`,
    );
  }
  return nodes.map(
    (node) =>
      responses.get(node.nodeId) ?? {
        nodeId: node.nodeId,
        status: "error" as const,
        diagnostics: ["render service returned no response for this formula"],
      },
  );
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the rock installs the service, most specific first:
 * the nvim rocks tree that `:Rocks install` writes to, then luarocks.
 */
function rocksBinCandidates(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const xdgData = env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : join(home, ".local", "share");
  return [
    join(xdgData, "nvim", "rocks", "bin", SERVICE_BINARY_NAME),
    join(home, ".luarocks", "bin", SERVICE_BINARY_NAME),
  ];
}

/** Look up an executable on `PATH` without spawning a shell. */
function lookUpOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.PATH ?? "";
  for (const entry of raw.split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the service binary: explicit option, then environment override, then
 * the rocks install, then `PATH`.
 */
export function resolveServiceBinary(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string | undefined {
  const override = explicit ?? env.PI_MATH_RENDERER_SERVICE;
  if (override && override.length > 0) {
    if (isAbsolute(override)) return isExecutable(override) ? override : undefined;
    const onPath = lookUpOnPath(override, env);
    if (onPath) return onPath;
    // A relative path is resolved against the working directory, and must be
    // executable like any other candidate.
    return isExecutable(override) ? override : undefined;
  }
  for (const candidate of rocksBinCandidates(env, home)) {
    if (isExecutable(candidate)) return candidate;
  }
  return lookUpOnPath(SERVICE_BINARY_NAME, env);
}
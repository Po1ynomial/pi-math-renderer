/**
 * Formula rendering plus the on-disk index that keeps repeat renders free.
 *
 * The service re-renders a formula whenever its in-process cache is cold, and
 * that cache dies with the process — which is every render for a `spawnSync`
 * client. The index file below records the PNG that was produced for a render
 * key, so a formula is rendered once per (source, colours, geometry) and then
 * never again, including across pi restarts.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_BASELINE_PT, type CellSize, naturalCells, renderPpi } from "./layout.ts";
import {
  type RenderedFormula,
  type RenderNode,
  renderBatch,
  RenderServiceError,
  type SpawnSyncFn,
} from "./service.ts";
import { buildContextSource, buildNodeSource } from "./typst.ts";

/** Bump to invalidate every cached PNG after a rendering change. */
const RENDERER_VERSION = "1";

/** One rendered formula on disk. */
export interface RenderEntry {
  key: string;
  path: string;
  widthPx: number;
  heightPx: number;
}

export interface RenderKeyInput {
  latex: string;
  colorHex: string;
  baselinePt: number;
  cell: CellSize;
  ppi: number;
}

/**
 * Stable key for everything that affects the produced pixels.
 *
 * The key names the service node, the local index entry and the kitty image id,
 * so it must not include anything that changes between renders of the same
 * formula (timestamps, session ids, widths).
 */
export function renderKey(input: RenderKeyInput): string {
  const canonical = [
    `v${RENDERER_VERSION}`,
    `formula:${input.latex}`,
    `color:${input.colorHex}`,
    `baseline:${input.baselinePt}`,
    `cell:${input.cell.widthPx}x${input.cell.heightPx}`,
    `ppi:${input.ppi}`,
  ].join("\n");
  return createHash("sha1").update(canonical).digest("hex");
}

/** Node id handed to the service; also the stem of the output file name. */
export function nodeIdFor(key: string): string {
  return `pi-mr-${key.slice(0, 24)}`;
}

/**
 * Key to entry mapping persisted as JSON.
 *
 * Writes are atomic (temp file + rename) because a crash mid-write would
 * otherwise discard the whole cache.
 */
export class RenderIndex {
  private readonly file: string;
  private entries: Map<string, RenderEntry> | undefined;
  private dirty = false;

  constructor(file: string) {
    this.file = file;
  }

  /** Entries whose PNG no longer exists are dropped. */
  get(key: string): RenderEntry | undefined {
    const entry = this.load().get(key);
    if (!entry) return undefined;
    if (existsSync(entry.path)) return entry;
    this.entries?.delete(key);
    this.dirty = true;
    return undefined;
  }

  set(entry: RenderEntry): void {
    this.load().set(entry.key, entry);
    this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;
    const entries = this.load();
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const payload = JSON.stringify({ version: RENDERER_VERSION, entries: [...entries.values()] });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, payload, "utf8");
      renameSync(temp, this.file);
      this.dirty = false;
    } catch {
      // A cache write failure must never break rendering.
    }
  }

  private load(): Map<string, RenderEntry> {
    if (this.entries) return this.entries;
    const entries = new Map<string, RenderEntry>();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as {
        version?: string;
        entries?: RenderEntry[];
      };
      if (raw.version === RENDERER_VERSION && Array.isArray(raw.entries)) {
        for (const entry of raw.entries) {
          if (entry && typeof entry.key === "string" && typeof entry.path === "string") {
            entries.set(entry.key, entry);
          }
        }
      }
    } catch {
      // Missing or corrupt index: start empty.
    }
    this.entries = entries;
    return entries;
  }
}

export interface FormulaRendererOptions {
  /** Rendering service executable; when absent, rendering is disabled. */
  serviceBinary: string | undefined;
  /** Directory for the PNGs and the index file. */
  cacheDir: string;
  /** Working root reported to the service (used for relative imports). */
  root: string;
  /** Current theme colour, read per render so theme switches are picked up. */
  colorHex: () => string;
  baselinePt?: number;
  /** Terminal cell size; read per render because it can change. */
  cellSize: () => CellSize;
  /** Override the derived ppi. */
  ppi?: number;
  timeoutMs?: number;
  spawnSync?: SpawnSyncFn;
  log?: (message: string) => void;
}

/**
 * Renders LaTeX display math and caches the result.
 *
 * Failures are remembered for the lifetime of the instance so a broken formula
 * or a missing service cannot cause a spawn storm during repeated renders.
 */
export class FormulaRenderer {
  private readonly index: RenderIndex;
  private readonly options: FormulaRendererOptions;
  private readonly failedKeys = new Set<string>();
  private serviceUnavailable = false;

  constructor(options: FormulaRendererOptions) {
    this.options = options;
    this.index = new RenderIndex(join(options.cacheDir, "index.json"));
  }

  /** Resolved ppi for the current theme/geometry; also part of the render key. */
  ppi(): number {
    if (this.options.ppi) return this.options.ppi;
    return renderPpi(this.options.cellSize(), this.baselinePt());
  }

  baselinePt(): number {
    return this.options.baselinePt ?? DEFAULT_BASELINE_PT;
  }

  /** Cache lookup only; never touches the service. */
  cached(latex: string): RenderEntry | undefined {
    if (!this.enabled) return undefined;
    const key = this.keyFor(latex);
    if (this.failedKeys.has(key)) return undefined;
    return this.index.get(key);
  }

  get enabled(): boolean {
    return this.options.serviceBinary !== undefined && !this.serviceUnavailable;
  }

  /**
   * Render every formula that is not cached yet, in one batch.
   *
   * One service call carries the whole batch, and it costs the same whether it
   * holds one formula or thirty (~140 ms for the process, measured), so nothing
   * is deferred: a transform has no reliable second chance, because pi runs the
   * transformer for new, streaming and restored messages and on width changes
   * only — a finalized message is never re-transformed, and a deferred formula
   * would stay as LaTeX source for the life of that view.
   */
  renderMissing(latexSources: string[]): Map<string, RenderEntry> {
    const result = new Map<string, RenderEntry>();
    if (!this.enabled) return result;

    const pending: { latex: string; key: string; node: RenderNode }[] = [];
    const seen = new Set<string>();
    for (const latex of latexSources) {
      const key = this.keyFor(latex);
      if (seen.has(key) || this.failedKeys.has(key)) continue;
      seen.add(key);
      const entry = this.index.get(key);
      if (entry) {
        result.set(latex, entry);
        continue;
      }
      pending.push({ latex, key, node: { nodeId: nodeIdFor(key), source: this.nodeSource(latex) } });
    }
    if (pending.length === 0) return result;

    let responses: RenderedFormula[];
    try {
      responses = renderBatch(
        pending.map((item) => item.node),
        {
          binary: this.options.serviceBinary as string,
          contextSource: buildContextSource(this.options.colorHex()),
          root: this.options.root,
          outputDir: this.options.cacheDir,
          ppi: this.ppi(),
          timeoutMs: this.options.timeoutMs,
        },
        this.options.spawnSync,
      );
    } catch (error) {
      if (error instanceof RenderServiceError) {
        this.serviceUnavailable = true;
        this.options.log?.(`render service unavailable: ${error.message}`);
      } else {
        this.options.log?.(`render failed: ${String(error)}`);
      }
      return result;
    }

    for (const response of responses) {
      const item = pending.find((candidate) => candidate.node.nodeId === response.nodeId);
      if (!item) continue;
      if (response.status !== "ok" || !response.path || !response.widthPx || !response.heightPx) {
        this.failedKeys.add(item.key);
        const reason = response.diagnostics.join("; ") || "unknown error";
        this.options.log?.(`formula render failed: ${reason}`);
        continue;
      }
      const entry: RenderEntry = {
        key: item.key,
        path: response.path,
        widthPx: response.widthPx,
        heightPx: response.heightPx,
      };
      this.index.set(entry);
      result.set(item.latex, entry);
    }
    this.index.save();
    return result;
  }

  /** Cell placement for an entry, given the terminal geometry. */
  placement(entry: RenderEntry): { cols: number; rows: number } {
    return naturalCells(entry.widthPx, entry.heightPx, this.options.cellSize());
  }

  private keyFor(latex: string): string {
    return renderKey({
      latex,
      colorHex: this.options.colorHex(),
      baselinePt: this.baselinePt(),
      cell: this.options.cellSize(),
      ppi: this.ppi(),
    });
  }

  private nodeSource(latex: string): string {
    return buildNodeSource({
      latex,
      display: "block",
      baselinePt: this.baselinePt(),
      cell: this.options.cellSize(),
    });
  }
}

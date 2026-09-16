/**
 * Formula rendering plus the cache that keeps repeat renders free.
 *
 * Behind the one method in {@link FormulaPlacements}: the render key, the
 * on-disk index, the batched service call, the failure memory and the cell
 * geometry. Callers hand over the formulas in a message and get a placement per
 * request back, or nothing for a formula that could not be rendered.
 */

import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { DEFAULT_BASELINE_PT, type CellPlacement, type CellSize, naturalCells, renderPpi } from "./layout.ts";
import { type RenderEntry, RenderIndex } from "./render-index.ts";
import {
  type RenderedFormula,
  type RenderNode,
  renderBatch,
  RenderServiceError,
  type SpawnSyncFn,
} from "./service.ts";
import { buildContextSource, buildNodeSource, type MathDisplay } from "./typst.ts";

/** Bump to invalidate every cached PNG after a rendering change. */
const RENDERER_VERSION = "2";

/**
 * A formula to render.
 *
 * The display kind is part of the request because it changes the pixels: block
 * math is snapped to whole cells, inline math is clipped to one cell. Two
 * requests with the same LaTeX and different kinds are different renders.
 */
export interface FormulaRequest {
  latex: string;
  display: MathDisplay;
}

/** A rendered formula, as the terminal will place it. */
export interface PlacedFormula {
  /** Render key; names the entry in the index file and appears in log lines. */
  key: string;
  /** PNG on disk, handed to the terminal as a path. */
  path: string;
  /** Whole terminal cells. */
  cols: number;
  rows: number;
}

/**
 * The formula-image interface the markdown passes work through.
 *
 * Requests in, placements out, in the same order. A request with no placement
 * (`undefined`) is a formula that could not be rendered, and the caller keeps
 * its source. Rendering never throws: a failed formula, an unreachable service
 * and a disabled renderer all answer `undefined`.
 *
 * Every placement is a cell rectangle in the current terminal, so a caller that
 * needs a narrower block fits the rectangle itself; it does not re-render.
 */
export interface FormulaPlacements {
  placements(requests: FormulaRequest[]): (PlacedFormula | undefined)[];
}

interface RenderKeyInput {
  latex: string;
  display: MathDisplay;
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
function renderKey(input: RenderKeyInput): string {
  const canonical = [
    `v${RENDERER_VERSION}`,
    `display:${input.display}`,
    `formula:${input.latex}`,
    `color:${input.colorHex}`,
    `baseline:${input.baselinePt}`,
    `cell:${input.cell.widthPx}x${input.cell.heightPx}`,
    `ppi:${input.ppi}`,
  ].join("\n");
  return createHash("sha1").update(canonical).digest("hex");
}

/** Node id handed to the service; also the stem of the output file name. */
function nodeIdFor(key: string): string {
  return `pi-mr-${key.slice(0, 24)}`;
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
 * Renders LaTeX math and caches the result.
 *
 * Failures are remembered for the lifetime of the instance so a broken formula
 * or a missing service cannot cause a spawn storm during repeated renders.
 */
export class FormulaRenderer implements FormulaPlacements {
  private readonly index: RenderIndex;
  private readonly options: FormulaRendererOptions;
  private readonly failedKeys = new Set<string>();
  private serviceUnavailable = false;

  constructor(options: FormulaRendererOptions) {
    this.options = options;
    this.index = new RenderIndex(join(options.cacheDir, "index.json"), RENDERER_VERSION);
  }

  /**
   * Placement for every request that can be drawn, in request order.
   *
   * One service call carries every formula that is missing, and it costs the
   * same whether it holds one formula or thirty (~140 ms for the process,
   * measured), so nothing is deferred: a transform has no reliable second
   * chance before the frame is drawn. pi does run the transformer again with
   * `isStreaming: false` when the message is finalized (and for restored
   * messages and width changes), but a formula deferred from one of those
   * passes could still stay as LaTeX source for the life of the view.
   *
   * Repeated requests share one render and get one placement each, because the
   * caller places one image per occurrence.
   */
  placements(requests: FormulaRequest[]): (PlacedFormula | undefined)[] {
    if (requests.length === 0) return [];
    if (!this.enabled) return requests.map(() => undefined);

    const keys = requests.map((request) => this.keyFor(request));
    const resolved = new Map<string, PlacedFormula | undefined>();
    const pending: { key: string; node: RenderNode }[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index] as string;
      if (resolved.has(key)) continue;
      // Provisional: a key stays unresolved until something places it.
      resolved.set(key, undefined);
      if (this.failedKeys.has(key)) continue;
      const entry = this.index.get(key);
      if (entry) {
        resolved.set(key, this.placed(entry));
        continue;
      }
      const request = requests[index] as FormulaRequest;
      pending.push({
        key,
        node: { nodeId: nodeIdFor(key), source: this.nodeSource(request) },
      });
    }
    if (pending.length === 0) return keys.map((key) => resolved.get(key));

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
      return keys.map((key) => resolved.get(key));
    }

    const keysByNodeId = new Map(pending.map((item) => [item.node.nodeId, item.key]));
    let rendered = 0;
    for (const response of responses) {
      const key = keysByNodeId.get(response.nodeId);
      if (key === undefined) continue;
      const fail = (reason: string): void => {
        this.failedKeys.add(key);
        this.options.log?.(`formula render failed: ${reason}`);
      };
      if (response.status !== "ok" || !response.path || !response.widthPx || !response.heightPx) {
        fail(response.diagnostics.join("; ") || "unknown error");
        continue;
      }
      // The placement hands the path to the terminal, which resolves relative
      // paths against its own working directory.
      if (!isAbsolute(response.path)) {
        fail(`render service returned a relative output path: ${response.path}`);
        continue;
      }
      const entry: RenderEntry = {
        key,
        path: response.path,
        widthPx: response.widthPx,
        heightPx: response.heightPx,
      };
      this.index.set(entry);
      resolved.set(key, this.placed(entry));
      rendered += 1;
    }
    this.index.save();
    this.options.log?.(`rendered ${rendered}/${pending.length} formula(s) in one batch`);
    return keys.map((key) => resolved.get(key));
  }

  private get enabled(): boolean {
    return this.options.serviceBinary !== undefined && !this.serviceUnavailable;
  }

  /** Resolved ppi for the current theme/geometry; also part of the render key. */
  private ppi(): number {
    if (this.options.ppi) return this.options.ppi;
    return renderPpi(this.options.cellSize(), this.baselinePt());
  }

  private baselinePt(): number {
    return this.options.baselinePt ?? DEFAULT_BASELINE_PT;
  }

  /** Cell placement for an entry, given the terminal geometry. */
  private placed(entry: RenderEntry): PlacedFormula {
    const cell: CellPlacement = naturalCells(entry.widthPx, entry.heightPx, this.options.cellSize());
    return { key: entry.key, path: entry.path, cols: cell.cols, rows: cell.rows };
  }

  private keyFor(request: FormulaRequest): string {
    return renderKey({
      latex: request.latex,
      display: request.display,
      colorHex: this.options.colorHex(),
      baselinePt: this.baselinePt(),
      cell: this.options.cellSize(),
      ppi: this.ppi(),
    });
  }

  private nodeSource(request: FormulaRequest): string {
    return buildNodeSource({
      latex: request.latex,
      display: request.display,
      baselinePt: this.baselinePt(),
      cell: this.options.cellSize(),
    });
  }
}

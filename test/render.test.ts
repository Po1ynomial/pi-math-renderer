import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FormulaRenderer, type FormulaRequest, type PlacedFormula } from "../src/render.ts";
import type { SpawnSyncFn } from "../src/service.ts";

const CELL = { widthPx: 11, heightPx: 30 };

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "pi-math-renderer-"));
}

/** Fake service that succeeds for every node and reports 132x30 px images. */
function successfulSpawn(pngPath: string): { spawn: SpawnSyncFn; calls: string[] } {
  const calls: string[] = [];
  const spawn: SpawnSyncFn = (_command, _args, options) => {
    calls.push(options.input);
    const request = JSON.parse(options.input.trim()) as { nodes: { node_id: string }[] };
    const stdout = request.nodes
      .map((node) =>
        JSON.stringify({
          type: "formula_rendered",
          node_id: node.node_id,
          status: "ok",
          path: pngPath,
          width_px: 132,
          height_px: 30,
        }),
      )
      .join("\n");
    return { status: 0, stdout: `${stdout}\n`, stderr: "" };
  };
  return { spawn, calls };
}

interface RendererOptions {
  serviceBinary?: string | undefined;
  cell?: { widthPx: number; heightPx: number };
  baselinePt?: number;
  ppi?: number;
  color?: () => string;
  log?: (message: string) => void;
}

function renderer(directory: string, spawn: SpawnSyncFn, options: RendererOptions = {}): FormulaRenderer {
  return new FormulaRenderer({
    serviceBinary: "serviceBinary" in options ? options.serviceBinary : "/opt/service",
    cacheDir: directory,
    root: directory,
    colorHex: options.color ?? (() => "#e5e5e7"),
    baselinePt: options.baselinePt ?? 11,
    cellSize: () => options.cell ?? CELL,
    ppi: options.ppi,
    spawnSync: spawn,
    log: options.log,
  });
}

/** Most tests only care about block math; inline requests are built inline. */
const block = (latex: string): FormulaRequest => ({ latex, display: "block" });
const inline = (latex: string): FormulaRequest => ({ latex, display: "inline" });

function placed(placements: (PlacedFormula | undefined)[]): PlacedFormula[] {
  const found = placements.filter((placement): placement is PlacedFormula => placement !== undefined);
  assert.equal(found.length, placements.length, "every request should have a placement");
  return found;
}

test("a batch renders every missing formula once and the cache survives a restart", () => {
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "formula.png");
    writeFileSync(png, "png");
    const { spawn, calls } = successfulSpawn(png);
    const first = renderer(directory, spawn);

    // A repeat is one render and one placement per occurrence: the caller draws
    // one image per placement, so both slots have to come back filled.
    const placements = placed(first.placements([block("x^2"), block("y^2"), block("x^2")]));
    assert.equal(calls.length, 1, "one batch for both formulas");
    assert.deepEqual(placements.map((item) => item.path), [png, png, png]);
    assert.deepEqual(placements[0], { key: placements[2]?.key, path: png, cols: 12, rows: 1 });

    // A second pass is served from the index without spawning again.
    assert.equal(placed(first.placements([block("x^2")])).length, 1);
    assert.equal(calls.length, 1);

    // The index is reusable across instances, which is what makes a restart free.
    assert.equal(placed(renderer(directory, spawn).placements([block("x^2")])).length, 1);
    assert.equal(calls.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every uncached formula goes out in one batch with file name stems", () => {
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "f.png");
    writeFileSync(png, "png");
    const { spawn, calls } = successfulSpawn(png);
    const renderer_ = renderer(directory, spawn);

    // Nothing may be deferred: a finalized message is never transformed again,
    // so a formula left for "later" would stay as LaTeX source.
    const placements = placed(renderer_.placements(["a", "b", "c", "d"].map(block)));
    assert.equal(placements.length, 4);
    assert.equal(calls.length, 1);

    const request = JSON.parse(calls[0]!.trim()) as { nodes: { node_id: string }[] };
    assert.equal(request.nodes.length, 4);
    for (const node of request.nodes) {
      assert.match(node.node_id, /^pi-mr-[0-9a-f]{24}$/, `${node.node_id} must be a valid file name stem`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("block and inline renders of one formula are separate renders", () => {
  // The display kind changes the pixels: block math is snapped to whole cells,
  // inline math is clipped to one cell. A shared key would serve one kind's PNG
  // to the other.
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "formula.png");
    writeFileSync(png, "png");
    const { spawn, calls } = successfulSpawn(png);
    const renderer_ = renderer(directory, spawn);

    assert.equal(placed(renderer_.placements([block("x^2")])).length, 1);
    assert.equal(placed(renderer_.placements([inline("x^2")])).length, 1);
    assert.equal(calls.length, 2, "the two kinds render separately");

    assert.match(calls[1]!, /clip: true/, "inline math is clipped to one cell");
    assert.doesNotMatch(calls[0]!, /clip: true/, "block math is snapped, not clipped");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a new theme colour, baseline, cell size or ppi renders again", () => {
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "formula.png");
    writeFileSync(png, "png");
    const { spawn, calls } = successfulSpawn(png);
    const request = [block("x^2")];

    placed(renderer(directory, spawn).placements(request));
    assert.equal(calls.length, 1);

    const recoloured = renderer(directory, spawn, { color: () => "#000000" });
    assert.equal(placed(recoloured.placements(request))[0]?.path, png);
    assert.equal(calls.length, 2);
    const sent = JSON.parse(calls[1]!.trim()) as { context_source: string };
    assert.match(sent.context_source, /rgb\("#000000"\)/, "the theme colour reaches the typst context");

    placed(renderer(directory, spawn, { baselinePt: 13 }).placements(request));
    assert.equal(calls.length, 3, "a different baseline is a different render");

    placed(renderer(directory, spawn, { cell: { widthPx: 9, heightPx: 18 } }).placements(request));
    assert.equal(calls.length, 4, "a different cell size is a different render");

    placed(renderer(directory, spawn, { cell: { widthPx: 9, heightPx: 18 }, ppi: 200 }).placements(request));
    assert.equal(calls.length, 5, "an explicit ppi override is a different render");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a relative output path is treated as a failed render", () => {
  // The path goes straight into the kitty command, where the terminal resolves
  // relative paths against its own working directory.
  const directory = temporaryDirectory();
  try {
    const logs: string[] = [];
    const spawn: SpawnSyncFn = (_command, _args, options) => {
      const request = JSON.parse(options.input.trim()) as { nodes: { node_id: string }[] };
      return {
        status: 0,
        stdout: `${request.nodes
          .map((node) =>
            JSON.stringify({
              type: "formula_rendered",
              node_id: node.node_id,
              status: "ok",
              path: "formula.png",
              width_px: 132,
              height_px: 30,
            }),
          )
          .join("\n")}\n`,
        stderr: "",
      };
    };
    const renderer_ = renderer(directory, spawn, { log: (message) => logs.push(message) });

    assert.deepEqual(renderer_.placements([block("x^2")]), [undefined]);
    assert.match(logs.join("\n"), /relative output path/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed formulas are remembered for the session", () => {
  const directory = temporaryDirectory();
  try {
    let calls = 0;
    const spawn: SpawnSyncFn = () => {
      calls += 1;
      return {
        status: 0,
        stdout: '{"type":"formula_rendered","node_id":"n","status":"error","diagnostics":[{"message":"bad"}]}\n',
        stderr: "",
      };
    };
    const renderer_ = renderer(directory, spawn);

    assert.deepEqual(renderer_.placements([block("broken")]), [undefined]);
    assert.deepEqual(renderer_.placements([block("broken")]), [undefined]);
    assert.equal(calls, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unavailable service stops rendering after the first attempt", () => {
  const directory = temporaryDirectory();
  const logs: string[] = [];
  let calls = 0;
  const spawn: SpawnSyncFn = () => {
    calls += 1;
    return { status: null, stdout: "", stderr: "", error: new Error("ENOENT") };
  };
  const renderer_ = renderer(directory, spawn, { log: (message) => logs.push(message) });

  assert.deepEqual(renderer_.placements([block("x")]), [undefined]);
  assert.deepEqual(renderer_.placements([block("y")]), [undefined]);
  assert.equal(calls, 1);
  assert.match(logs.join("\n"), /unavailable/);
});

test("a disabled renderer never spawns", () => {
  const directory = temporaryDirectory();
  try {
    const spawn: SpawnSyncFn = () => {
      throw new Error("should not spawn");
    };
    const renderer_ = renderer(directory, spawn, { serviceBinary: undefined });

    assert.deepEqual(renderer_.placements([block("x")]), [undefined]);
    assert.deepEqual(renderer_.placements([]), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
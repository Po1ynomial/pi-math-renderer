import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FormulaRenderer,
  nodeIdFor,
  RenderIndex,
  renderKey,
  requestId,
  type FormulaRequest,
} from "../src/render.ts";
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

/** Most tests only care about block math; inline requests are built inline. */
const block = (latex: string): FormulaRequest => ({ latex, display: "block" });

test("render keys depend on everything that changes pixels", () => {
  const base = { latex: "x^2", display: "block" as const, colorHex: "#e5e5e7", baselinePt: 11, cell: CELL, ppi: 196 };
  const key = renderKey(base);
  assert.match(key, /^[0-9a-f]{40}$/);
  assert.equal(key, renderKey({ ...base }));
  assert.notEqual(key, renderKey({ ...base, latex: "x^3" }));
  assert.notEqual(key, renderKey({ ...base, colorHex: "#000000" }));
  assert.notEqual(key, renderKey({ ...base, baselinePt: 13 }));
  assert.notEqual(key, renderKey({ ...base, cell: { widthPx: 9, heightPx: 18 } }));
  assert.notEqual(key, renderKey({ ...base, ppi: 118 }));
});

test("block and inline renders of one formula are separate cache entries", () => {
  // The display kind changes the pixels: block math is snapped to whole cells,
  // inline math is clipped to one. A shared key would serve one kind's PNG to
  // the other.
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "formula.png");
    writeFileSync(png, "png");
    const { spawn, calls } = successfulSpawn(png);
    const renderer = new FormulaRenderer({
      serviceBinary: "/opt/service",
      cacheDir: directory,
      root: directory,
      colorHex: () => "#e5e5e7",
      baselinePt: 11,
      cellSize: () => CELL,
      spawnSync: spawn,
    });

    const inline: FormulaRequest = { latex: "x^2", display: "inline" };
    const blockRequest: FormulaRequest = { latex: "x^2", display: "block" };
    assert.notEqual(
      renderKey({ latex: "x^2", display: "inline", colorHex: "#e5e5e7", baselinePt: 11, cell: CELL, ppi: renderer.ppi() }),
      renderKey({ latex: "x^2", display: "block", colorHex: "#e5e5e7", baselinePt: 11, cell: CELL, ppi: renderer.ppi() }),
    );

    renderer.renderMissing([blockRequest]);
    assert.ok(renderer.cached(blockRequest));
    assert.equal(renderer.cached(inline), undefined, "inline must not read the block entry");

    renderer.renderMissing([inline]);
    assert.ok(renderer.cached(inline));
    assert.equal(calls.length, 2, "the two kinds render separately");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("node ids are stable per key and valid file name stems", () => {
  const key = renderKey({ latex: "x", display: "block", colorHex: "#fff", baselinePt: 11, cell: CELL, ppi: 196 });
  assert.equal(nodeIdFor(key), nodeIdFor(key));
  assert.match(nodeIdFor(key), /^pi-mr-[0-9a-f]{24}$/);
});

test("index entries survive a reload and drop deleted files", () => {
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "formula.png");
    writeFileSync(png, "png");
    const file = join(directory, "index.json");

    const index = new RenderIndex(file);
    index.set({ key: "k1", path: png, widthPx: 132, heightPx: 30 });
    index.set({ key: "k2", path: join(directory, "gone.png"), widthPx: 1, heightPx: 1 });
    index.save();

    const reloaded = new RenderIndex(file);
    assert.deepEqual(reloaded.get("k1"), { key: "k1", path: png, widthPx: 132, heightPx: 30 });
    assert.equal(reloaded.get("k2"), undefined);
    assert.equal(reloaded.get("missing"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt or outdated index starts empty", () => {
  const directory = temporaryDirectory();
  try {
    const file = join(directory, "index.json");
    writeFileSync(file, "{not json");
    assert.equal(new RenderIndex(file).get("k"), undefined);

    writeFileSync(file, JSON.stringify({ version: "0", entries: [{ key: "k", path: "/x" }] }));
    assert.equal(new RenderIndex(file).get("k"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("renderer renders missing formulas once and caches them", () => {
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "formula.png");
    writeFileSync(png, "png");
    const { spawn, calls } = successfulSpawn(png);
    const renderer = new FormulaRenderer({
      serviceBinary: "/opt/service",
      cacheDir: directory,
      root: directory,
      colorHex: () => "#e5e5e7",
      baselinePt: 11,
      cellSize: () => CELL,
      spawnSync: spawn,
    });

    assert.equal(renderer.cached(block("x^2")), undefined);
    const rendered = renderer.renderMissing(["x^2", "y^2", "x^2"].map(block));
    assert.equal(rendered.size, 2);
    assert.equal(calls.length, 1, "one batch for both formulas");
    assert.equal(renderer.cached(block("x^2"))?.path, png);
    assert.deepEqual(
      renderer.placement(rendered.get(requestId({ latex: "x^2", display: "block" }))!),
      { cols: 12, rows: 1 },
    );

    // Second pass is served from the index without spawning again.
    const again = renderer.renderMissing(["x^2"].map(block));
    assert.equal(again.size, 1);
    assert.equal(calls.length, 1);

    // The index is reusable across instances.
    const reloaded = new FormulaRenderer({
      serviceBinary: "/opt/service",
      cacheDir: directory,
      root: directory,
      colorHex: () => "#e5e5e7",
      baselinePt: 11,
      cellSize: () => CELL,
      spawnSync: spawn,
    });
    assert.equal(reloaded.cached(block("x^2"))?.path, png);
    assert.equal(calls.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a new theme colour forces a fresh render", () => {
  const directory = temporaryDirectory();
  try {
    const first = join(directory, "a.png");
    const second = join(directory, "b.png");
    writeFileSync(first, "png");
    writeFileSync(second, "png");
    let color = "#e5e5e7";
    let path = first;
    const calls: string[] = [];
    const spawn: SpawnSyncFn = (_command, _args, options) => {
      calls.push(options.input);
      const request = JSON.parse(options.input.trim()) as { nodes: { node_id: string }[] };
      return {
        status: 0,
        stdout: `${request.nodes
          .map((node) =>
            JSON.stringify({
              type: "formula_rendered",
              node_id: node.node_id,
              status: "ok",
              path,
              width_px: 132,
              height_px: 30,
            }),
          )
          .join("\n")}\n`,
        stderr: "",
      };
    };
    const renderer = new FormulaRenderer({
      serviceBinary: "/opt/service",
      cacheDir: directory,
      root: directory,
      colorHex: () => color,
      baselinePt: 11,
      cellSize: () => CELL,
      spawnSync: spawn,
    });

    renderer.renderMissing(["x^2"].map(block));
    assert.equal(calls.length, 1);
    color = "#000000";
    path = second;
    const rendered = renderer.renderMissing(["x^2"].map(block));
    assert.equal(calls.length, 2);
    assert.equal(rendered.get(requestId({ latex: "x^2", display: "block" }))?.path, second);

    const context = JSON.parse(calls[1]!.trim()) as { context_source: string };
    assert.match(context.context_source, /rgb\("#000000"\)/);
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
    const renderer = new FormulaRenderer({
      serviceBinary: "/opt/service",
      cacheDir: directory,
      root: directory,
      colorHex: () => "#fff",
      baselinePt: 11,
      cellSize: () => CELL,
      spawnSync: spawn,
    });
    assert.equal(renderer.renderMissing(["broken"].map(block)).size, 0);
    assert.equal(renderer.renderMissing(["broken"].map(block)).size, 0);
    assert.equal(calls, 1);
    assert.equal(renderer.cached(block("broken")), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unavailable service disables rendering after the first attempt", () => {
  const directory = temporaryDirectory();
  const logs: string[] = [];
  let calls = 0;
  const spawn: SpawnSyncFn = () => {
    calls += 1;
    return { status: null, stdout: "", stderr: "", error: new Error("ENOENT") };
  };
  const renderer = new FormulaRenderer({
    serviceBinary: "/opt/service",
    cacheDir: directory,
    root: directory,
    colorHex: () => "#fff",
    baselinePt: 11,
    cellSize: () => CELL,
    spawnSync: spawn,
    log: (message) => logs.push(message),
  });
  assert.equal(renderer.renderMissing(["x"].map(block)).size, 0);
  assert.equal(renderer.renderMissing(["y"].map(block)).size, 0);
  assert.equal(calls, 1);
  assert.equal(renderer.enabled, false);
  assert.match(logs.join("\n"), /unavailable/);
  assert.equal(renderer.cached(block("x")), undefined);
});

test("one transform renders every uncached formula in one batch", () => {
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "f.png");
    writeFileSync(png, "png");
    let batches = 0;
    const spawn: SpawnSyncFn = (_command, _args, options) => {
      batches += 1;
      const request = JSON.parse(options.input.trim()) as { nodes: { node_id: string }[] };
      return {
        status: 0,
        stdout: `${request.nodes
          .map((node) =>
            JSON.stringify({
              type: "formula_rendered",
              node_id: node.node_id,
              status: "ok",
              path: png,
              width_px: 132,
              height_px: 30,
            }),
          )
          .join("\n")}\n`,
        stderr: "",
      };
    };
    const renderer = new FormulaRenderer({
      serviceBinary: "/opt/service",
      cacheDir: directory,
      root: directory,
      colorHex: () => "#fff",
      cellSize: () => CELL,
      spawnSync: spawn,
    });
    // Nothing may be deferred: a finalized message is never transformed again,
    // so a formula left for "later" would stay as LaTeX source.
    const rendered = renderer.renderMissing(["a", "b", "c", "d"].map(block));
    assert.equal(rendered.size, 4);
    assert.equal(batches, 1);
    assert.deepEqual(
      [...rendered.keys()].sort(),
      ["a", "b", "c", "d"].map((latex) => requestId({ latex, display: "block" })).sort(),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a disabled renderer never spawns", () => {
  const directory = temporaryDirectory();
  try {
    const spawn: SpawnSyncFn = () => {
      throw new Error("should not spawn");
    };
    const renderer = new FormulaRenderer({
      serviceBinary: undefined,
      cacheDir: directory,
      root: directory,
      colorHex: () => "#fff",
      cellSize: () => CELL,
      spawnSync: spawn,
    });
    assert.equal(renderer.enabled, false);
    assert.equal(renderer.renderMissing(["x"].map(block)).size, 0);
    assert.equal(renderer.cached(block("x")), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("near misses in the cache file are ignored", () => {
  const directory = temporaryDirectory();
  try {
    const file = join(directory, "index.json");
    writeFileSync(
      file,
      JSON.stringify({ version: "1", entries: [{ key: 5, path: null }, { key: "ok", path: "/tmp/x" }] }),
    );
    const index = new RenderIndex(file);
    assert.equal(index.get("ok"), undefined, "path must exist on disk");
    assert.equal(readFileSync(file, "utf8").length > 0, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

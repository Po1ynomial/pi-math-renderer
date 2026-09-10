import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildRequest,
  lookUpOnPath,
  parseResponses,
  renderBatch,
  RenderServiceError,
  resolveServiceBinary,
  rocksBinCandidates,
  SERVICE_BINARY_NAME,
  type SpawnSyncFn,
} from "../src/service.ts";

const batchOptions = {
  binary: "/opt/service",
  contextSource: "#set page(width: auto)\n",
  root: "/tmp",
  outputDir: "/tmp/cache",
  ppi: 196,
};

test("responses are keyed by node id", () => {
  const stdout = [
    '{"type":"formula_rendered","node_id":"a","status":"ok","path":"/tmp/a.png","width_px":10,"height_px":20}',
    '{"type":"formula_rendered","node_id":"b","status":"error","diagnostics":[{"message":"bad tex"}]}',
    "not json",
    "",
  ].join("\n");
  const responses = parseResponses(stdout);
  assert.equal(responses.size, 2);
  assert.deepEqual(responses.get("a"), {
    nodeId: "a",
    status: "ok",
    path: "/tmp/a.png",
    widthPx: 10,
    heightPx: 20,
    diagnostics: [],
  });
  assert.deepEqual(responses.get("b")?.diagnostics, ["bad tex"]);
});

test("request shape matches the service protocol", () => {
  const request = JSON.parse(
    buildRequest(
      [{ nodeId: "n1", source: "#mitex(\"x\")" }],
      { ...batchOptions, ppi: 195.6, workerCount: 99, requestId: "r1", cacheKey: "k" },
    ),
  );
  assert.equal(request.type, "render_formulas");
  assert.equal(request.request_id, "r1");
  assert.equal(request.cache_key, "k");
  assert.equal(request.ppi, 196);
  assert.equal(request.worker_count, 8);
  assert.equal(request.output_dir, "/tmp/cache");
  assert.deepEqual(request.inputs, {});
  assert.deepEqual(request.nodes, [
    { node_id: "n1", node_rev: 1, kind: "math", source: "#mitex(\"x\")" },
  ]);
});

test("batch results keep request order and surface per-node failures", () => {
  const spawn: SpawnSyncFn = (_command, _args, options) => {
    assert.equal(options.input.split("\n").length, 2);
    return {
      status: 0,
      stdout:
        '{"type":"formula_rendered","node_id":"b","status":"ok","path":"/tmp/b.png","width_px":2,"height_px":3}\n',
      stderr: "",
    };
  };
  const responses = renderBatch(
    [
      { nodeId: "a", source: "A" },
      { nodeId: "b", source: "B" },
    ],
    batchOptions,
    spawn,
  );
  assert.equal(responses[0]?.status, "error");
  assert.equal(responses[0]?.nodeId, "a");
  assert.equal(responses[1]?.status, "ok");
  assert.equal(responses[1]?.path, "/tmp/b.png");
});

test("empty batches never spawn the service", () => {
  const spawn: SpawnSyncFn = () => {
    throw new Error("should not spawn");
  };
  assert.deepEqual(renderBatch([], batchOptions, spawn), []);
});

test("a service that produces no output raises", () => {
  const spawn: SpawnSyncFn = () => ({ status: 1, stdout: "", stderr: "boom", error: new Error("exit 1") });
  assert.throws(() => renderBatch([{ nodeId: "a", source: "A" }], batchOptions, spawn), RenderServiceError);
});

test("rocks candidates cover the nvim rocks tree", () => {
  const candidates = rocksBinCandidates({ XDG_DATA_HOME: "/data" }, "/home/u");
  assert.deepEqual(candidates, [
    join("/data", "nvim", "rocks", "bin", SERVICE_BINARY_NAME),
    join("/home/u", ".luarocks", "bin", SERVICE_BINARY_NAME),
  ]);
  // Without XDG_DATA_HOME the default location is used.
  assert.equal(
    rocksBinCandidates({}, "/home/u")[0],
    join("/home/u", ".local", "share", "nvim", "rocks", "bin", SERVICE_BINARY_NAME),
  );
});

test("binary resolution prefers explicit, then env, then installed copies", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-math-renderer-bin-"));
  try {
    const binary = join(directory, SERVICE_BINARY_NAME);
    writeFileSync(binary, "#!/bin/sh\n");
    chmodSync(binary, 0o755);

    assert.equal(resolveServiceBinary(binary, {}, directory), binary);
    assert.equal(
      resolveServiceBinary(undefined, { PI_MATH_RENDERER_SERVICE: binary }, "/nope"),
      binary,
    );
    // Installed in an XDG rocks tree.
    const dataHome = join(directory, "data");
    const rocksBin = join(dataHome, "nvim", "rocks", "bin");
    mkdirSync(rocksBin, { recursive: true });
    writeFileSync(join(rocksBin, SERVICE_BINARY_NAME), "#!/bin/sh\n");
    chmodSync(join(rocksBin, SERVICE_BINARY_NAME), 0o755);
    assert.equal(
      resolveServiceBinary(undefined, { PATH: "", XDG_DATA_HOME: dataHome }, directory),
      join(rocksBin, SERVICE_BINARY_NAME),
    );
    assert.equal(resolveServiceBinary(undefined, { PATH: "", XDG_DATA_HOME: directory }, directory), undefined);

    const onPath = lookUpOnPath(SERVICE_BINARY_NAME, { PATH: directory });
    assert.equal(onPath, binary);
    assert.equal(lookUpOnPath(SERVICE_BINARY_NAME, { PATH: "/nonexistent" }), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a relative override must be executable as well", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-math-renderer-rel-"));
  const cwd = process.cwd();
  try {
    const name = "rel-service";
    writeFileSync(join(directory, name), "not executable");
    chmodSync(join(directory, name), 0o644);
    process.chdir(directory);
    // exists, but not executable: still unusable
    assert.equal(resolveServiceBinary(name, { PATH: "" }, directory), undefined);
    chmodSync(join(directory, name), 0o755);
    assert.equal(resolveServiceBinary(name, { PATH: "" }, directory), name);
  } finally {
    process.chdir(cwd);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing or non-executable override disables rendering", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-math-renderer-bin-"));
  try {
    const plain = join(directory, SERVICE_BINARY_NAME);
    writeFileSync(plain, "not executable");
    chmodSync(plain, 0o644);
    assert.equal(resolveServiceBinary(plain, { PATH: "" }, directory), undefined);
    assert.equal(resolveServiceBinary("/definitely/missing", { PATH: "" }, directory), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

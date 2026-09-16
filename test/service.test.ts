import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  renderBatch,
  RenderServiceError,
  resolveServiceBinary,
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

test("unusable response lines are ignored and diagnostics are flattened", () => {
  const spawn: SpawnSyncFn = () => ({
    status: 0,
    stderr: "",
    stdout: [
      '{"type":"formula_rendered","node_id":"a","status":"ok","path":"/tmp/a.png","width_px":10,"height_px":20}',
      '{"type":"formula_rendered","node_id":"b","status":"error","diagnostics":[{"message":"bad tex"},"no closing brace"]}',
      '{"type":"formula_rendered","node_id":"stranger","status":"ok","path":"/tmp/x.png","width_px":1,"height_px":1}',
      '{"type":"something_else","node_id":"a"}',
      "not json",
      "",
    ].join("\n"),
  });
  const responses = renderBatch(
    [
      { nodeId: "a", source: "A" },
      { nodeId: "b", source: "B" },
    ],
    batchOptions,
    spawn,
  );
  assert.deepEqual(responses[0], {
    nodeId: "a",
    status: "ok",
    path: "/tmp/a.png",
    widthPx: 10,
    heightPx: 20,
    diagnostics: [],
  });
  assert.equal(responses[1]?.status, "error");
  assert.deepEqual(responses[1]?.diagnostics, ["bad tex", "no closing brace"]);
  assert.equal(responses.length, 2, "a response for an unrequested node is dropped");
});

test("the request shape matches the service protocol", () => {
  const sent: string[] = [];
  const spawn: SpawnSyncFn = (_command, _args, options) => {
    sent.push(options.input);
    return { status: 0, stderr: "", stdout: '{"type":"formula_rendered","node_id":"n1","status":"ok","path":"/tmp/n.png","width_px":1,"height_px":1}\n' };
  };
  renderBatch([{ nodeId: "n1", source: '#mitex("x")' }], { ...batchOptions, ppi: 195.6 }, spawn);

  const request = JSON.parse(sent[0]!.trim()) as Record<string, unknown>;
  assert.equal(request.type, "render_formulas");
  assert.match(String(request.request_id), /^pi-math-renderer:/);
  assert.equal(request.context_id, "pi-math-renderer");
  assert.equal(request.context_rev, 1);
  assert.equal(request.context_source, batchOptions.contextSource);
  assert.equal(request.root, "/tmp");
  assert.equal(request.output_dir, batchOptions.outputDir);
  assert.equal(request.ppi, 196, "ppi is rounded for the service");
  assert.equal(request.worker_count, 2);
  assert.deepEqual(request.inputs, {});
  assert.deepEqual(request.nodes, [
    { node_id: "n1", node_rev: 1, kind: "math", source: '#mitex("x")' },
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

test("a rocks install is found without XDG_DATA_HOME or a PATH", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-math-renderer-home-"));
  try {
    const install = (path: string): string => {
      mkdirSync(path, { recursive: true });
      const binary = join(path, SERVICE_BINARY_NAME);
      writeFileSync(binary, "#!/bin/sh\n");
      chmodSync(binary, 0o755);
      return binary;
    };

    // The default XDG location under the home directory.
    const xdg = install(join(home, ".local", "share", "nvim", "rocks", "bin"));
    assert.equal(resolveServiceBinary(undefined, { PATH: "" }, home), xdg);

    // A luarocks install is the fallback when the rocks tree has nothing.
    const luarocks = install(join(home, ".luarocks", "bin"));
    rmSync(xdg, { force: true });
    assert.equal(resolveServiceBinary(undefined, { PATH: "" }, home), luarocks);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

    // On the PATH, for an install that is not in a rocks tree.
    assert.equal(resolveServiceBinary(undefined, { PATH: directory }, "/nope"), binary);
    assert.equal(resolveServiceBinary(undefined, { PATH: "/nonexistent" }, "/nope"), undefined);
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

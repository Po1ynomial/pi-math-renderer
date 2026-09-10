import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, tuiModeFromArgv } from "../src/config.ts";
import { SERVICE_BINARY_NAME } from "../src/service.ts";

function serviceDirectory(): { directory: string; binary: string } {
  const directory = mkdtempSync(join(tmpdir(), "pi-math-renderer-cfg-"));
  const binary = join(directory, SERVICE_BINARY_NAME);
  writeFileSync(binary, "#!/bin/sh\n");
  chmodSync(binary, 0o755);
  return { directory, binary };
}

test("tui mode is read from argv in both spellings", () => {
  assert.equal(tuiModeFromArgv(["--tui-mode", "fullscreen"]), "fullscreen");
  assert.equal(tuiModeFromArgv(["--tui-mode=regular"]), "regular");
  assert.equal(tuiModeFromArgv(["--verbose"]), undefined);
  assert.equal(tuiModeFromArgv(["--tui-mode"]), undefined);
});

test("configuration defaults to enabled when the service is installed", () => {
  const { directory, binary } = serviceDirectory();
  try {
    const config = loadConfig({
      env: { PI_MATH_RENDERER_SERVICE: binary },
      argv: [],
      home: directory,
      readSettings: () => ({}),
    });
    assert.equal(config.enabled, true);
    assert.equal(config.serviceBinary, binary);
    assert.equal(config.baselinePt, 11);
    assert.equal(config.debug, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("environment overrides are parsed defensively", () => {
  const { directory, binary } = serviceDirectory();
  try {
    const config = loadConfig({
      env: {
        PI_MATH_RENDERER_SERVICE: binary,
        PI_MATH_RENDERER_BASELINE_PT: "13",
        PI_MATH_RENDERER_PPI: "300",
        PI_MATH_RENDERER_TIMEOUT_MS: "5000",
        PI_MATH_RENDERER_DEBUG: "1",
      },
      argv: [],
      home: directory,
      readSettings: () => ({}),
    });
    assert.deepEqual(
      { baselinePt: config.baselinePt, ppi: config.ppi, timeoutMs: config.timeoutMs, debug: config.debug },
      { baselinePt: 13, ppi: 300, timeoutMs: 5000, debug: true },
    );

    const junk = loadConfig({
      env: { PI_MATH_RENDERER_SERVICE: binary, PI_MATH_RENDERER_BASELINE_PT: "abc", PI_MATH_RENDERER_PPI: "-1" },
      argv: [],
      home: directory,
      readSettings: () => ({}),
    });
    assert.equal(junk.baselinePt, 11);
    assert.equal(junk.ppi, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the formula colour can be overridden", () => {
  const { directory, binary } = serviceDirectory();
  try {
    const read = (value?: string) =>
      loadConfig({
        env: { PI_MATH_RENDERER_SERVICE: binary, ...(value ? { PI_MATH_RENDERER_COLOR: value } : {}) },
        argv: [],
        home: directory,
        readSettings: () => ({}),
      }).color;
    assert.equal(read("#FF8800"), "#ff8800");
    assert.equal(read("red"), undefined);
    assert.equal(read("#ff88"), undefined);
    assert.equal(read(), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PI_MATH_RENDERER=0 disables the extension", () => {
  const { directory, binary } = serviceDirectory();
  try {
    const config = loadConfig({
      env: { PI_MATH_RENDERER: "0", PI_MATH_RENDERER_SERVICE: binary },
      argv: [],
      home: directory,
      readSettings: () => ({}),
    });
    assert.equal(config.enabled, false);
    assert.match(config.disabledReason ?? "", /PI_MATH_RENDERER/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fullscreen mode disables image rendering", () => {
  const { directory, binary } = serviceDirectory();
  try {
    const flag = loadConfig({
      env: { PI_MATH_RENDERER_SERVICE: binary },
      argv: ["--tui-mode", "fullscreen"],
      home: directory,
      readSettings: () => ({}),
    });
    assert.equal(flag.enabled, false);
    assert.match(flag.disabledReason ?? "", /fullscreen/);

    const persisted = loadConfig({
      env: { PI_MATH_RENDERER_SERVICE: binary },
      argv: [],
      home: directory,
      readSettings: () => ({ tuiMode: "fullscreen" }),
    });
    assert.equal(persisted.enabled, false);

    // The command line wins over the persisted setting.
    const overridden = loadConfig({
      env: { PI_MATH_RENDERER_SERVICE: binary },
      argv: ["--tui-mode=regular"],
      home: directory,
      readSettings: () => ({ tuiMode: "fullscreen" }),
    });
    assert.equal(overridden.enabled, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing service disables the extension with a hint", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-math-renderer-cfg-"));
  try {
    const config = loadConfig({
      env: { PATH: directory, XDG_DATA_HOME: directory },
      argv: [],
      home: directory,
      readSettings: () => ({}),
    });
    assert.equal(config.enabled, false);
    assert.match(config.disabledReason ?? "", /math-conceal-service/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

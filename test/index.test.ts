import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import mathRenderer, { createSession, type RendererEnvironment } from "../src/index.ts";
import type { Config } from "../src/config.ts";
import { type FormulaRequest } from "../src/render.ts";
import type { SpawnSyncFn } from "../src/service.ts";

const CELL = { widthPx: 11, heightPx: 30 };
const FORMULA = "\\int_0^1 x^2 \\, dx = \\frac{1}{3}";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "pi-math-renderer-index-"));
}

function context(overrides: Partial<MarkdownTransformContext> = {}): MarkdownTransformContext {
  return { messageType: "assistant", isStreaming: false, availableWidth: 113, ...overrides };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    baselinePt: 11,
    streaming: false,
    debug: false,
    serviceBinary: "/opt/math-conceal-service",
    ...overrides,
  };
}

/** Fake service that succeeds for every node. */
function successfulSpawn(pngPath: string): { spawn: SpawnSyncFn; calls: string[] } {
  const calls: string[] = [];
  const spawn: SpawnSyncFn = (_command, _args, options) => {
    calls.push(options.input);
    const request = JSON.parse(options.input.trim()) as { nodes: { node_id: string }[] };
    return {
      status: 0,
      stderr: "",
      stdout: `${request.nodes
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
        .join("\n")}\n`,
    };
  };
  return { spawn, calls };
}

/** The part of pi the extension touches, with everything it registers kept. */
interface FakePi {
  api: ExtensionAPI;
  flags: Map<string, boolean | string | undefined>;
  transformer?: (markdown: string, context: MarkdownTransformContext) => string;
  handlers: Map<string, (event: unknown, ctx: unknown) => void>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

function fakePi(): FakePi {
  const fake: FakePi = {
    api: undefined as unknown as ExtensionAPI,
    flags: new Map(),
    handlers: new Map(),
    commands: new Map(),
  };
  fake.api = {
    registerFlag: (name: string) => fake.flags.set(name, undefined),
    getFlag: (name: string) => fake.flags.get(name),
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      fake.commands.set(name, options),
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => fake.handlers.set(event, handler),
    registerMarkdownTransformer: (
      transformer: (markdown: string, context: MarkdownTransformContext) => string,
    ) => {
      fake.transformer = transformer;
    },
  } as unknown as ExtensionAPI;
  return fake;
}

function environment(
  directory: string,
  spawn: SpawnSyncFn,
  overrides: Partial<RendererEnvironment> = {},
): RendererEnvironment {
  return {
    config: config(),
    cacheDir: directory,
    root: directory,
    cellSize: () => CELL,
    capabilities: () => ({ images: "kitty" }),
    spawnSync: spawn,
    ...overrides,
  };
}

test("a usable terminal and service get a transformer", () => {
  const directory = temporaryDirectory();
  try {
    const pi = fakePi();
    mathRenderer(pi.api, environment(directory, successfulSpawn(join(directory, "f.png")).spawn));

    assert.equal(typeof pi.transformer, "function");
    assert.deepEqual([...pi.flags.keys()].sort(), ["math-images-streaming", "no-math-images"]);
    assert.ok(pi.commands.has("math-renderer"));
    assert.ok(pi.handlers.has("session_start"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a terminal that cannot draw images gets no transformer", () => {
  const directory = temporaryDirectory();
  try {
    for (const images of [null, "iterm2"] as const) {
      const pi = fakePi();
      mathRenderer(
        pi.api,
        environment(directory, successfulSpawn(join(directory, "f.png")).spawn, {
          capabilities: () => ({ images }),
        }),
      );
      assert.equal(pi.transformer, undefined, `${String(images)} must not be treated as kitty`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a disabled configuration registers no transformer", () => {
  const directory = temporaryDirectory();
  try {
    const pi = fakePi();
    mathRenderer(
      pi.api,
      environment(directory, successfulSpawn(join(directory, "f.png")).spawn, {
        config: config({ enabled: false, disabledReason: "disabled by PI_MATH_RENDERER" }),
      }),
    );
    assert.equal(pi.transformer, undefined);
    // The command is still registered, so the reason can be asked for.
    assert.ok(pi.commands.has("math-renderer"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the transformer reads the flags on every call", () => {
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "f.png");
    writeFileSync(png, "png");
    const pi = fakePi();
    mathRenderer(pi.api, environment(directory, successfulSpawn(png).spawn));
    const transform = pi.transformer;
    assert.ok(transform);

    const markdown = `$$\n${FORMULA}\n$$\n`;
    assert.ok(transform(markdown, context()).includes("\x1b_G"));

    pi.flags.set("no-math-images", true);
    assert.equal(transform(markdown, context()), markdown);

    pi.flags.set("no-math-images", false);
    assert.ok(transform(markdown, context()).includes("\x1b_G"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the session's service, geometry and colour reach the request", () => {
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "f.png");
    writeFileSync(png, "png");
    const { spawn, calls } = successfulSpawn(png);
    const session = createSession({
      config: config({ baselinePt: 13, ppi: 200, color: "#123456" }),
      cacheDir: directory,
      root: "/tmp/session-root",
      cellSize: () => CELL,
      themeColor: () => "#e5e5e7",
      spawnSync: spawn,
    });

    const request: FormulaRequest = { latex: "x^2", display: "block" };
    assert.equal(session.renderer.placements([request])[0]?.path, png);

    const sent = JSON.parse(calls[0]!.trim()) as {
      root: string;
      output_dir: string;
      ppi: number;
      context_source: string;
      nodes: { source: string }[];
    };
    assert.equal(sent.root, "/tmp/session-root");
    assert.equal(sent.output_dir, directory);
    assert.equal(sent.ppi, 200, "the configured ppi wins over the derived one");
    assert.match(sent.context_source, /rgb\("#123456"\)/, "the configured colour wins over the theme");
    assert.match(sent.nodes[0]!.source, /#set text\(size: 13pt\)/, "the baseline reaches the formula");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a theme change re-points the colour the transformer renders in", () => {
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "f.png");
    writeFileSync(png, "png");
    const { spawn, calls } = successfulSpawn(png);
    const pi = fakePi();
    mathRenderer(pi.api, environment(directory, spawn));
    const transform = pi.transformer;
    const start = pi.handlers.get("session_start");
    assert.ok(transform && start);

    /** The typst context document the stubbed service was handed. */
    const contextSource = (call: string): string =>
      (JSON.parse(call.trim()) as { context_source: string }).context_source;

    const markdown = `$$\n${FORMULA}\n$$\n`;
    // Before a theme is known, the fallback colour is used.
    transform(markdown, context());
    assert.match(contextSource(calls[0]!), /rgb\("#e5e5e7"\)/);

    // pi re-points the theme at session start, and the colour is part of the
    // render key, so the same formula renders again in the new colour.
    start({}, { ui: { theme: { getFgAnsi: () => "\u001b[38;2;1;2;3m" } } });
    transform(markdown, context());
    assert.equal(calls.length, 2, "a theme change must render again");
    assert.match(contextSource(calls[1]!), /rgb\("#010203"\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the status command reports what was configured", async () => {
  const directory = temporaryDirectory();
  try {
    const pi = fakePi();
    mathRenderer(
      pi.api,
      environment(directory, successfulSpawn(join(directory, "f.png")).spawn, {
        config: config({ serviceBinary: "/opt/math-conceal-service", baselinePt: 13 }),
      }),
    );
    const command = pi.commands.get("math-renderer");
    assert.ok(command);

    const notified: string[] = [];
    const ctx = { ui: { notify: (message: string) => notified.push(message) } };
    await command.handler("", ctx);
    assert.match(notified.join("\n"), /math images on/);
    assert.match(notified.join("\n"), /streaming off/);
    assert.match(notified.join("\n"), /service math-conceal-service/);
    assert.match(notified.join("\n"), /baseline 13pt/);

    pi.flags.set("no-math-images", true);
    notified.length = 0;
    await command.handler("", ctx);
    assert.match(notified.join("\n"), /math images off/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
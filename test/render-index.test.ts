import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RenderIndex } from "../src/render-index.ts";

/** The version tag is the renderer's; the index only compares it. */
const VERSION = "test";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "pi-math-renderer-index-"));
}

test("index entries survive a reload and drop deleted files", () => {
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "formula.png");
    writeFileSync(png, "png");
    const file = join(directory, "index.json");

    const index = new RenderIndex(file, VERSION);
    index.set({ key: "k1", path: png, widthPx: 132, heightPx: 30 });
    index.set({ key: "k2", path: join(directory, "gone.png"), widthPx: 1, heightPx: 1 });
    index.save();

    const reloaded = new RenderIndex(file, VERSION);
    assert.deepEqual(reloaded.get("k1"), { key: "k1", path: png, widthPx: 132, heightPx: 30 });
    assert.equal(reloaded.get("k2"), undefined);
    assert.equal(reloaded.get("missing"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt file or an index from another version starts empty", () => {
  const directory = temporaryDirectory();
  try {
    const file = join(directory, "index.json");
    writeFileSync(file, "{not json");
    assert.equal(new RenderIndex(file, VERSION).get("k"), undefined);

    // The tag changes when a rendering change invalidates every cached PNG.
    writeFileSync(file, JSON.stringify({ version: "other", entries: [{ key: "k", path: "/x" }] }));
    assert.equal(new RenderIndex(file, VERSION).get("k"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed entries are not served or written back", () => {
  const directory = temporaryDirectory();
  try {
    const png = join(directory, "formula.png");
    writeFileSync(png, "png");
    const file = join(directory, "index.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: VERSION,
        entries: [{ key: 5, path: null }, { key: "ok", path: png }],
      }),
    );

    const index = new RenderIndex(file, VERSION);
    assert.equal(index.get("ok")?.path, png);
    index.set({ key: "added", path: png, widthPx: 1, heightPx: 1 });
    index.save();

    const written = JSON.parse(readFileSync(file, "utf8")) as { entries: { key: string }[] };
    assert.deepEqual(
      written.entries.map((entry) => entry.key).sort(),
      ["added", "ok"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createImageIdAllocator,
  displayCommand,
  MAX_IMAGE_ID,
  sanitiseImageId,
} from "../src/kitty.ts";

test("display command transmits by path and declares the cell rectangle", () => {
  const command = displayCommand("/tmp/formula.png", 0x11001d, 13, 3);
  assert.match(command, /^\x1b_Ga=T,f=100,q=2,t=f,c=13,r=3,C=1,i=1114141;/);
  assert.ok(command.endsWith("\x1b\\"));
  const payload = command.slice(command.indexOf(";") + 1, -2);
  assert.equal(Buffer.from(payload, "base64").toString("utf8"), "/tmp/formula.png");
});

test("display command owns cursor movement so the host keeps row accounting", () => {
  // C=1 means kitty must not move the cursor after drawing.
  assert.match(displayCommand("/tmp/f.png", 1, 4, 2), /C=1/);
  assert.ok(!displayCommand("/tmp/f.png", 1, 4, 2).includes("U=1"));
});

test("display command clamps degenerate spans", () => {
  assert.match(displayCommand("/tmp/f.png", 1, 0, -5), /,c=1,r=1,/);
  assert.match(displayCommand("/tmp/f.png", 1, 12.7, 3.2), /,c=12,r=3,/);
});

test("display command never emits an id kitty would drop", () => {
  // Regression: ids were combined with `& 0xffffffff`, which wraps anything
  // above 2^31 into a negative number in JavaScript. kitty drops a placement
  // whose id is negative without replying, so those formulas were simply
  // invisible — a little over half of them, at random.
  for (const input of [1, 2147483647, 2147483648, 3670165512, 4294967295, -1, -624801784, 0]) {
    const command = displayCommand("/tmp/f.png", input, 4, 2);
    const id = /,i=(-?\d+);/.exec(command)?.[1];
    assert.ok(id !== undefined, `no id in ${command}`);
    assert.ok(!id.startsWith("-"), `negative id ${id} for input ${input}`);
    assert.ok(Number(id) >= 1 && Number(id) <= MAX_IMAGE_ID, `id ${id} out of range`);
    // pi finds ids on a line with a digits-only pattern, so a valid id must be
    // plain digits for pi's delete-by-id bookkeeping to work.
    assert.equal([...command.matchAll(/i=(\d+)/g)].length, 1);
  }
});

test("sanitise keeps valid ids and clamps the rest", () => {
  assert.equal(sanitiseImageId(1), 1);
  assert.equal(sanitiseImageId(123456789), 123456789);
  assert.equal(sanitiseImageId(MAX_IMAGE_ID), MAX_IMAGE_ID);
  assert.equal(sanitiseImageId(MAX_IMAGE_ID + 1), MAX_IMAGE_ID);
  assert.equal(sanitiseImageId(0), 1);
  assert.equal(sanitiseImageId(-5), 1);
  assert.equal(sanitiseImageId(Number.NaN), 1);
  assert.equal(sanitiseImageId(12.7), 12);
});

test("image ids are unique per placement, non-zero and 32-bit", () => {
  // pi deletes every placement of an id when it rewrites a line, so sharing an
  // id between two placements makes them erase each other (see blocks.test.ts).
  const allocate = createImageIdAllocator(() => 0.5);
  const ids = new Set<number>();
  for (let index = 0; index < 5000; index += 1) {
    const value = allocate();
    assert.ok(value > 0 && value <= MAX_IMAGE_ID, `id out of range: ${value}`);
    ids.add(value);
  }
  assert.equal(ids.size, 5000);
});

test("id allocation starts at a random offset and wraps around", () => {
  const seen: number[] = [];
  for (const seed of [0, 0.25, 0.999999]) {
    seen.push(createImageIdAllocator(() => seed)());
  }
  assert.notEqual(seen[0], seen[1]);
  assert.notEqual(seen[1], seen[2]);

  const nearEnd = createImageIdAllocator(() => (MAX_IMAGE_ID - 1) / MAX_IMAGE_ID);
  const last = nearEnd();
  assert.ok(last > 0 && last <= MAX_IMAGE_ID);
  assert.equal(nearEnd(), 1);
});

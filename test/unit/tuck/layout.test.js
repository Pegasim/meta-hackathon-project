import test from "node:test";
import assert from "node:assert/strict";
// layout.js is a classic content script: it defines globalThis.tuckLayout.
await import("../../../src/tuck/layout.js");
const { placement, clamp } = globalThis.tuckLayout;

const view = { width: 1200, height: 800 };
const avatar = (x, y) => ({ x, y, width: 72, height: 72 });

test("on the right half the bubble opens leftwards, below Tuck", () => {
  assert.deepEqual(placement(avatar(1100, 16), view), { side: "left", vertical: "below" });
});

test("dragged to the left half, the bubble opens rightwards", () => {
  assert.deepEqual(placement(avatar(20, 16), view), { side: "right", vertical: "below" });
});

test("in the bottom half the bubble opens above Tuck", () => {
  assert.deepEqual(placement(avatar(20, 700), view), { side: "right", vertical: "above" });
  assert.deepEqual(placement(avatar(1100, 700), view), { side: "left", vertical: "above" });
});

test("a saved position stays inside the window, with a margin", () => {
  assert.deepEqual(clamp({ x: -50, y: 5000 }, { width: 72, height: 72 }, view), { x: 8, y: 720 });
  assert.deepEqual(clamp({ x: 300, y: 200 }, { width: 72, height: 72 }, view), { x: 300, y: 200 });
  assert.deepEqual(clamp({ x: 1190, y: -3 }, { width: 72, height: 72 }, view), { x: 1120, y: 8 });
});

const { anchor, fromAnchor } = globalThis.tuckLayout;
const size = { width: 72, height: 72 };

test("a position is saved as its distance from the nearest corner", () => {
  assert.deepEqual(anchor({ x: 20, y: 16 }, size, view), { h: "left", v: "top", dx: 20, dy: 16 });
  assert.deepEqual(anchor({ x: 1100, y: 700 }, size, view), { h: "right", v: "bottom", dx: 28, dy: 28 });
});

test("in a window of another size Tuck keeps that distance", () => {
  const saved = anchor({ x: 1100, y: 700 }, size, view);
  assert.deepEqual(fromAnchor(saved, size, { width: 800, height: 600 }), { x: 700, y: 500 });
  assert.deepEqual(fromAnchor(saved, size, view), { x: 1100, y: 700 });
});

test("a position saved before anchors is read from the top left", () => {
  assert.deepEqual(fromAnchor({ x: 300, y: 200 }, size, view), { x: 300, y: 200 });
});

test("fitting a small window does not change what was saved", () => {
  const saved = anchor({ x: 20, y: 600 }, size, view); // bottom left
  const small = { width: 400, height: 150 };
  assert.deepEqual(clamp(fromAnchor(saved, size, small), size, small), { x: 20, y: 8 });
  assert.deepEqual(fromAnchor(saved, size, view), { x: 20, y: 600 });
});

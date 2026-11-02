// End-to-end (issue #34): Tuck stands in one place on every page. Dragged in one tab, it
// moves in the tabs already open, with no reload; a new tab opens there; in a wider
// window it keeps its distance from the nearest corner; and a window shrunk and restored
// puts it back where it was.
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert/strict";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.resolve(import.meta.dirname, "../../src");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-position-"));

const server = http.createServer((req, res) =>
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>${req.url}</title><p>${req.url}`),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;

const SIZE = { width: 420, height: 720 };
const ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
  headless: false,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  viewport: SIZE,
  args: ["--headless=new", `--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
let [worker] = ctx.serviceWorkers();
worker ??= await ctx.waitForEvent("serviceworker");
const ext = `chrome-extension://${new URL(worker.url()).host}`;
const errors = [];

// A goal, so Tuck rests on every page.
const settings = await ctx.newPage();
await settings.goto(`${ext}/options/options.html`);
await settings.evaluate(() => chrome.runtime.sendMessage({ type: "set-intent", title: "Fix the checkout bug" }));

// Tuck's box on a page once it is drawn; null if it never shows within `ms`.
async function tuckAt(page, ms = 10000) {
  const avatar = page.locator("#tuck-companion .avatar");
  await avatar.waitFor({ timeout: ms }).catch(() => {});
  await page.waitForTimeout(700); // the slide-in, and any update in flight
  const box = await avatar.boundingBox();
  return box && { x: Math.round(box.x), y: Math.round(box.y) };
}
async function open(p) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url(p));
  await page.bringToFront();
  return page;
}

const a = await open("/a");
const before = await tuckAt(a);
const b = await open("/b");
const bBefore = await tuckAt(b);

// Dragged in tab A, towards the bottom right.
await a.bringToFront();
await a.mouse.move(before.x + 36, before.y + 36);
await a.mouse.down();
await a.mouse.move(300, 500, { steps: 8 });
await a.mouse.up();
const dragged = await tuckAt(a);

// Tab B, open the whole time, then brought to the front: no reload.
await b.bringToFront();
const bAfter = await tuckAt(b);
// A new tab opens there.
const c = await open("/c");
const cAt = await tuckAt(c);
// A wider window: the same distance from the right and bottom edges.
await c.setViewportSize({ width: 800, height: 720 });
const wide = await tuckAt(c);
// Shrunk below Tuck, then restored: back where it was.
await c.setViewportSize({ width: 420, height: 200 });
const shrunk = await tuckAt(c);
await c.setViewportSize(SIZE);
const restored = await tuckAt(c);

await ctx.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log({ before, bBefore, dragged, bAfter, cAt, wide, shrunk, restored });
assert.deepEqual(errors, []);
assert.ok(before && bBefore && dragged, "Tuck rests on both tabs");
assert.notDeepEqual(dragged, before, "the drag moved Tuck");
assert.deepEqual(bAfter, dragged, "a tab already open shows the new position, no reload");
assert.deepEqual(cAt, dragged, "a new tab opens at the saved position");
assert.deepEqual(
  { right: 800 - wide.x, y: wide.y },
  { right: SIZE.width - dragged.x, y: dragged.y },
  "a wider window keeps the distance from the nearest corner",
);
assert.ok(shrunk.y + 72 <= 200, "a short window keeps Tuck inside");
assert.deepEqual(restored, dragged, "restoring the window puts Tuck back where it was");
console.log("extension position e2e: ok");

// End-to-end (issue #26): Tuck leaves the page with its extension, and two copies of the
// extension never show two pets. Two copies of src/ load in Chromium, each with a goal;
// one pet shows. Removing the copy that draws takes its pet off the open page with no
// reload; the other copy draws on the next page; reloading it from chrome://extensions
// takes the old load's pet off too.
//
// Chromium here does not bring back an extension loaded with --load-extension after a
// reload (no new service worker within 15 s), so what a reload is checked for is that
// the earlier load's pet leaves, not that the new load draws exactly one.
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert/strict";

const { chromium } = createRequire(import.meta.url)("playwright");
const src = path.resolve(import.meta.dirname, "../../src");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-copies-"));
const copies = ["a", "b"].map((name) => {
  const dir = path.join(tmp, name);
  fs.cpSync(src, dir, { recursive: true });
  return dir;
});

const server = http.createServer((req, res) =>
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>${req.url}</title><p>${req.url}`),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;

const ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
  headless: false,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  viewport: { width: 420, height: 720 },
  args: ["--headless=new", `--disable-extensions-except=${copies.join(",")}`, `--load-extension=${copies.join(",")}`],
});
while (ctx.serviceWorkers().length < copies.length) await ctx.waitForEvent("serviceworker");
const ids = ctx.serviceWorkers().map((w) => new URL(w.url()).host);
const errors = [];

// Polls from node until the page holds `n` pets, or gives up after `ms`.
async function petsBecome(page, n, ms = 8000) {
  const end = Date.now() + ms;
  let count = await page.locator("#tuck-companion").count();
  while (count !== n && Date.now() < end) {
    await page.waitForTimeout(250);
    count = await page.locator("#tuck-companion").count();
  }
  return count;
}
const owner = (page) => page.locator("#tuck-companion").first().getAttribute("data-owner");
const extensionPage = async (id) => {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/options/options.html`);
  return p;
};
// Its page closes as the extension goes, so the call does not return.
const remove = async (id) =>
  (await extensionPage(id)).evaluate(() => void chrome.management.uninstallSelf()).catch(() => {});

// Both copies have a goal: each would rest Tuck on the page.
for (const id of ids)
  await (
    await extensionPage(id)
  ).evaluate(() => chrome.runtime.sendMessage({ type: "set-intent", title: "Fix the checkout bug" }));
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url("/one"));
await page.bringToFront();
await petsBecome(page, 1);
await page.waitForTimeout(3000); // time for the other copy to draw too
const withBoth = await page.locator("#tuck-companion").count();
const mark = await owner(page);
const drawing = mark ?? ids[0]; // unmarked (before #26): remove either
const other = ids.find((id) => id !== drawing);

// The copy that draws is removed: its pet leaves the open page, no reload.
await remove(drawing);
await page.bringToFront();
const afterRemove = await petsBecome(page, 0);

// The copy left draws on the next page.
await page.goto(url("/two"));
await page.bringToFront();
const nextPage = await petsBecome(page, 1);
const nextOwner = nextPage ? await owner(page) : null;

// Reloaded from chrome://extensions: the earlier load's pet does not stay behind.
const extensions = await ctx.newPage();
await extensions.goto("chrome://extensions");
const reload = await extensions.evaluate(
  (id) =>
    new Promise((done) =>
      chrome.developerPrivate.reload(id, { failQuietly: true }, () => done(chrome.runtime.lastError?.message ?? "ok")),
    ),
  other,
);
await page.bringToFront();
const afterReload = await petsBecome(page, 0);

await ctx.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });

assert.deepEqual(errors, []);
assert.equal(ids.length, 2, "two copies loaded");
assert.equal(afterRemove, 0, "removing the extension takes its pet off the open page");
assert.equal(withBoth, 1, "two copies installed show one pet");
assert.ok(ids.includes(mark), `the pet names its copy: ${mark}`);
assert.equal(nextPage, 1, "the copy left draws on the next page");
assert.equal(nextOwner, other);
assert.equal(reload, "ok");
assert.equal(afterReload, 0, "a reload leaves no pet from the earlier load");
console.log("extension copies e2e: ok");

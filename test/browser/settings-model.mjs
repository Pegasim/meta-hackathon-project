// End-to-end (issue #68): a brain connected before any model was saved is read as soon as
// the model is saved in Settings, with no press on Re-read my memory. The task status says
// "needs a model above" only while none is saved, and "not read yet" when no run has read
// the notes. The task node runs in the Settings page, so closing the page mid-run stops it
// and keeps none of the batches it read: the progress status asks to keep the page open.
//
// Settings is used as a person uses it: the model is saved with its Save button, so the
// calls go to Meta's address, which the test answers with a fake model.
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert/strict";
import { PROVIDERS } from "../../src/memory/model.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.resolve(import.meta.dirname, "../../src"); // the extension
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ext-settings-model-"));

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--headless=new", `--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
let [worker] = ctx.serviceWorkers();
worker ??= await ctx.waitForEvent("serviceworker");
const settingsUrl = `chrome-extension://${new URL(worker.url()).host}/options/options.html`;
const errors = [];

// The fake model: every entry is a task, no two are one commitment, and the profile is fixed.
const taskCalls = [];
const otherCalls = [];
let delayMs = 0;
await ctx.route(`${PROVIDERS.meta.baseUrl}/chat/completions`, async (route) => {
  const { messages } = route.request().postDataJSON();
  let content;
  if (/short to-do list/.test(messages[0].content)) {
    taskCalls.push(Date.now());
    const items = messages
      .at(-1)
      .content.split("\n\n")
      .filter((b) => /^\d+\. /.test(b))
      .map((b) => ({
        n: Number(b.match(/^\d+/)[0]),
        is_task: true,
        still_open: true,
        task: b.split("\n")[0].replace(/^\d+\. \[[^\]]+\] [a-z]+, [\d-]+: /, ""),
        who: null,
        personal: false,
      }));
    content = { items };
  } else if (/same commitment/.test(messages[0].content)) {
    otherCalls.push("pairs");
    const n = messages
      .at(-1)
      .content.split("\n\n")
      .filter((b) => /^\d+\.\n/.test(b)).length;
    content = { pairs: Array.from({ length: n }, (_, i) => ({ n: i + 1, same: false })) };
  } else {
    otherCalls.push("profile");
    content = { summary: "Runs errands and keeps a garden.", topics: ["errands"], workHosts: [] };
  }
  await new Promise((r) => setTimeout(r, delayMs));
  // A page closed mid-run has no one to answer.
  await route
    .fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    })
    .catch(() => {});
});

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const note = (id, topic, title) => ({
  path: `notes/log/2026/${id}.md`,
  text: [
    "---",
    `title: "${title}"`,
    "kind: todo",
    `topic: ${topic}`,
    `date: ${day(2)}`,
    "source: test",
    `id: ${id}`,
    "---",
    "",
    "- **Context:** Invented for the test.",
    "- **Decision/Result:** Noted.",
    "- **Evidence:** none",
    "- **Next action:** Do it",
  ].join("\n"),
});
const errands = Array.from({ length: 20 }, (_, i) => note(`err${i + 1}`, "errands", `Errand ${i + 1}`));
const garden = Array.from({ length: 100 }, (_, i) => note(`gdn${i + 1}`, "garden", `Garden job ${i + 1}`));

async function openSettings() {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(settingsUrl);
  await page.waitForFunction(() => document.getElementById("task-status").textContent !== "");
  return page;
}
// The brain's notes, as the Connect folder button reads them (a test cannot click the picker).
const connectBrain = (page, files) =>
  page.evaluate(async (files) => {
    const { Memory } = await import("/memory/index.js");
    await (await Memory.open()).importFiles(files);
  }, files);
const stored = (page) =>
  page.evaluate(async () => {
    const { taskVerdicts, modelSettings } = await chrome.storage.local.get(["taskVerdicts", "modelSettings"]);
    const { Memory } = await import("/memory/index.js");
    const session = (await chrome.storage.session.get("modelSettings")).modelSettings;
    return {
      verdicts: taskVerdicts ? Object.keys(taskVerdicts).length : null,
      model: !!(session ?? modelSettings),
      profile: (await (await Memory.open()).profile())?.summary ?? null,
    };
  });
// Every text the task status shows, from now on.
const recordStatus = (page) =>
  page.evaluate(() => {
    window.statuses = [];
    const el = document.getElementById("task-status");
    new MutationObserver(() => window.statuses.push(el.textContent)).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
const settled = (page) =>
  page.waitForFunction(
    () =>
      !/^Reading/.test(document.getElementById("profile-status").textContent) &&
      !/^Reading/.test(document.getElementById("task-status").textContent),
  );

// 1. The brain is connected before any model is saved, so Connect's re-read reads nothing.
let page = await openSettings();
await connectBrain(page, errands);
await page.click("#reread");
await settled(page);
const noModel = { status: await page.locator("#task-status").innerText(), ...(await stored(page)) };

// 2. The model is saved with Save, and nothing else is pressed.
await recordStatus(page);
await page.fill("#key", "test-key");
await page.click("#save");
const saveDeadline = Date.now() + 15000;
while ((await stored(page)).verdicts === null && Date.now() < saveDeadline) await page.waitForTimeout(200);
await settled(page);
await page.waitForTimeout(300);
const afterSave = {
  ...(await stored(page)),
  taskCalls: taskCalls.length,
  rows: await page.locator("#task-list .row").count(),
  status: await page.locator("#task-status").innerText(),
  profileStatus: await page.locator("#profile-status").innerText(),
  statuses: await page.evaluate(() => window.statuses),
};

// 3. A longer run (100 more notes, 7 batches, 3 at a time, 1 s each), and Settings is
// closed once the first batches are back.
await connectBrain(page, [...errands, ...garden]);
delayMs = 1000;
const callsBefore = taskCalls.length;
await page.click("#reread");
await page.waitForFunction(() => /\d+ of \d+/.test(document.getElementById("task-status").textContent));
const midRun = await page.locator("#task-status").innerText();
await page.close();
const callsAtClose = taskCalls.length - callsBefore;
await new Promise((r) => setTimeout(r, 4000));
const callsLater = taskCalls.length - callsBefore;

// 4. Settings again, with the model saved and the garden notes never read.
delayMs = 0;
page = await openSettings();
const reopened = { status: await page.locator("#task-status").innerText(), ...(await stored(page)) };

await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });

console.log({ noModel, afterSave, midRun, callsAtClose, callsLater, reopened, otherCalls });
assert.deepEqual(errors, []);

assert.equal(noModel.model, false);
assert.equal(noModel.verdicts, null, "with no model, Connect's re-read runs no task node");
assert.match(noModel.status, /needs a model above/);
assert.match(noModel.status, /20 notes with a next action are not listed/);

assert.ok(afterSave.taskCalls > 0, "saving the model runs the task node, with no press on Re-read");
assert.equal(afterSave.verdicts, 20, "every errand is judged");
assert.equal(afterSave.rows, 7, "the first seven tasks are listed");
assert.equal(afterSave.profile, "Runs errands and keeps a garden.", "saving the model reads the profile too");
assert.match(afterSave.profileStatus, /Tuck knows you as: Runs errands/);
assert.doesNotMatch(afterSave.status, /needs a model|not listed/);
assert.ok(
  afterSave.statuses.some((s) => /^Reading your tasks.*Keep this page open/.test(s)),
  JSON.stringify(afterSave.statuses),
);

// What closing Settings mid-run does: no call starts after it, and none of the batches
// that came back is kept, so the page must stay open.
assert.match(midRun, /^Reading your tasks… \d+ of 100\. Keep this page open/);
assert.ok(callsAtClose < 7, `the run was closed before its last batch (${callsAtClose} of 7 calls)`);
assert.equal(callsLater, callsAtClose, "no call starts once Settings is closed");
assert.equal(reopened.verdicts, 20, "the batches read before the page closed are not kept");

assert.equal(reopened.model, true);
assert.match(reopened.status, /not read yet/);
assert.doesNotMatch(reopened.status, /needs a model/, "a saved model is not asked for");
assert.match(reopened.status, /100 notes with a next action are not listed/);
console.log("settings model e2e: ok");

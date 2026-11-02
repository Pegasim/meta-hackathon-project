// End-to-end: the real extension in Chromium against a local fake model.
// Goal from the popup → related page → unrelated page → drift trigger, badge and
// popup card → "Take me back" (also when the related tab was closed) → "This is
// for my task" silences that page, for a while → the second look (issue #5): a work
// chat on a social page is not a drift, typing holds the nudge, a chat box left
// focused does not speak for the feed but typing in it does, a page with a password
// field is not read → the exported event log holds it all.
// Saves screenshots of the popup and settings page to SCREENSHOT_DIR when set.
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert/strict";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.resolve(import.meta.dirname, "../../src"); // the extension
const shots = process.env.SCREENSHOT_DIR;

// Two "sites" (different hostnames for the same server) and a fake model that
// calls the video unrelated and everything else related.
const calls = [];
const nudgeCalls = [];
const taskCalls = [];
// Typed into a reply box, then left: form values are never read, so it must never
// reach the model. Not secret-shaped, so redaction alone would not hide it.
const DRAFT = "unsent draft about hunter2 and the moon";
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.end();
  const page = (title) =>
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>${title}</title><p>${title}`);
  if (req.url === "/repo") return page("cart.js · acme/shop");
  if (req.url === "/video") return page("Top 10 F1 crashes - Video");
  // Issue #5: one social site, three pages. The title says "Social" on all of them.
  const reply = `<textarea id="reply" placeholder="Write a message"></textarea>`;
  if (req.url === "/chat")
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(
        `<title>Messages | Social</title><main><h1>Ali</h1>` +
          `<p>Ali: did you find why the checkout drops the last item from the cart?</p>` +
          `<p>Me: yes, cart.js splices the wrong index when the quantity is zero.</p>` +
          `<p>Ali: nice. can you write the failing test for the checkout bug first?</p>` +
          `<p>Me: on it, then I'll open the pull request for the checkout fix tonight.</p>` +
          `<p>Ali: great, ping me when the checkout test is red so I can review it.</p>${reply}</main>`,
      );
  if (req.url === "/compose")
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(`<title>Feed | Social</title><main><p>Ten cats that look like famous paintings.</p>${reply}</main>`);
  // A feed in the middle, a chat about the goal docked at the bottom (LinkedIn's layout).
  if (req.url === "/side")
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(
        `<title>Home | Social</title><main style="padding-bottom:260px">` +
          `<p>Promoted: is your brand visible in AI answers? Get a free analysis today.</p>` +
          `<p>Deniz started a new role as head of growth at Acme. Congratulations!</p>` +
          `<p>Five lessons I learned from running my first marathon in the rain.</p>` +
          `<p>Ten cats that look like famous paintings, ranked by a museum curator.</p>` +
          `<p>Hiring: senior designer, remote, apply before Friday.</p></main>` +
          `<aside style="position:fixed;bottom:0;left:0;right:0;height:240px;overflow:auto;background:#eee">` +
          `<p>Ali: the checkout still drops the last cart item when the quantity is zero.</p>` +
          `<p>Me: cart.js splices the wrong index, I am writing the failing test for it now.</p>` +
          `<p>Ali: good, open the pull request for the checkout fix when the test is red.</p>` +
          `<p>Me: will do, then the demo of the checkout flow.</p>` +
          `<p>Ali: perfect, and add a note on the zero quantity edge case in the description.</p>${reply}</aside>`,
      );
  // A chat in an open shadow root, docked over a page with a comment box (LinkedIn's layout).
  if (req.url === "/docked")
    return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      `<title>Workspace</title><main style="height:3000px"><h1>Feed</h1><p id="post">A post.</p>` +
        `<textarea id="comment"></textarea></main><div id="outlet" style="position:fixed;bottom:0;right:0"></div><script>
          document.getElementById("outlet").attachShadow({ mode: "open" }).innerHTML =
            '<div id="docked-chat" role="dialog" aria-label="Messaging"><h2>Ali Demir</h2>' +
            '<p aria-label="Options for the message from Ali: secret plan">secret plan</p>' +
            '<div id="docked-box" role="textbox" contenteditable="true" style="height:40px;width:200px"></div></div>';
        </script>`,
    );
  // The same layout on a social site, which the fake model calls unrelated.
  if (req.url === "/docked-social")
    return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      `<title>Cats | Social</title><main style="height:3000px"><p>A post about cats.</p></main>` +
        `<div id="outlet" style="position:fixed;bottom:0;right:0"></div><script>
          document.getElementById("outlet").attachShadow({ mode: "open" }).innerHTML =
            '<div role="dialog" aria-label="Messaging"><h2>Ali Demir</h2>' +
            '<div id="social-box" role="textbox" contenteditable="true" style="height:40px;width:200px"></div></div>';
        </script>`,
    );
  // A chat with someone only the notes know about.
  if (req.url === "/known-chat")
    return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      `<title>Dogs | Social</title><main style="height:3000px"><p>A post about dogs.</p></main>` +
        `<div id="outlet" style="position:fixed;bottom:0;right:0"></div><script>
          document.getElementById("outlet").attachShadow({ mode: "open" }).innerHTML =
            '<div role="dialog" aria-label="Messaging"><h2>Deniz Kaya</h2>' +
            '<div id="known-box" role="textbox" contenteditable="true" style="height:40px;width:200px"></div></div>';
        </script>`,
    );
  // Issue #23: a chat in an open shadow root, nothing typed. In the middle of the window (the
  // lookup at that point returns only its host), with an unsent draft in its box.
  const feedText =
    "<p>Promoted: is your brand visible in AI answers? Get a free analysis today.</p>" +
    "<p>Deniz started a new role as head of growth at Acme. Congratulations on the move!</p>" +
    "<p>Five lessons I learned from running my first marathon in the rain last spring.</p>" +
    "<p>Ten cats that look like famous paintings, ranked by a museum curator on a slow day.</p>" +
    "<p>Hiring: senior designer, remote, apply before Friday to join a small friendly team.</p>";
  const chatRoot = (box, style) =>
    `<div id="outlet" style="${style}"></div><script>
          document.getElementById("outlet").attachShadow({ mode: "open" }).innerHTML =
            '<div role="dialog" aria-label="Messaging"><h2>Ali Demir</h2>' +
            '<p>Ali: did you find why the checkout drops the last item?</p>' +
            '<p>Me: yes, cart.js splices the wrong index when the quantity is zero.</p>' +
            '<div id="${box}" role="textbox" contenteditable="true" style="height:40px">${DRAFT}</div></div>';
        </script>`;
  if (req.url === "/centre-chat")
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(
        `<title>Network | Social</title><main style="height:3000px">${feedText}</main>` +
          chatRoot("centre-box", "position:fixed;top:280px;left:40px;width:340px;background:#eee"),
      );
  // The same chat docked at the bottom, under a feed in the middle.
  if (req.url === "/dock-feed")
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(
        `<title>Updates | Social</title><main style="padding-bottom:300px">${feedText}</main>` +
          chatRoot("dock-box", "position:fixed;bottom:0;right:0;width:190px;background:#eee"),
      );
  // An article about chat with a feedback box: not a conversation.
  if (req.url === "/docs/chat-api")
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(`<title>Chat API docs</title><main><h2>Was this helpful?</h2><textarea id="feedback"></textarea></main>`);
  // A page the fake model is unsure about.
  if (req.url === "/maybe")
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(`<title>Maybe work</title><main>Hm.</main>`);
  // The full messaging page: no dialog, the box is in the main area.
  if (req.url === "/messaging/thread/1")
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(
        `<title>Messaging</title><main><section><h2>Ali Demir</h2>` +
          `<div id="thread-box" role="textbox" contenteditable="true" style="height:40px"></div></section></main>`,
      );
  if (req.url === "/login")
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(
        `<title>Sign in | Social</title><main><p>Welcome back. Sign in to Social.</p>` +
          `<input name="user"><input type="password" name="pass"></main>`,
      );
  if (req.url !== "/v1/chat/completions") return res.writeHead(404).end();
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { messages } = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    // Tuck's words (agent/nudge.js).
    if (/You are Tuck/.test(messages[0].content)) {
      nudgeCalls.push(messages);
      const message = "Still on the video? Back to the failing test.";
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message }) } }] }));
    }
    // The task list (agent/tasks.js): a note to keep watching is no task, a later note that
    // says "booked" closes the venue, and every other entry is a task, named anew.
    if (/short to-do list/.test(messages[0].content)) {
      taskCalls.push(messages);
      const items = messages
        .at(-1)
        .content.split("\n\n")
        .filter((b) => /^\d+\. /.test(b))
        .map((b) => {
          const title = b.split("\n")[0].replace(/^\d+\. \[[^\]]+\] [a-z]+, [\d-]+: /, "");
          return {
            n: Number(b.match(/^\d+/)[0]),
            is_task: !/Keep an eye/.test(b),
            still_open: !/booked/.test(b),
            task: title.replace(/^Errand/, "Run errand"),
            who: null,
            personal: false,
          };
        });
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }));
    }
    calls.push(messages);
    // Notes that name the person spoken to: that conversation is work.
    const prompt = messages.at(-1).content;
    if (/From their own notes:[\s\S]*Deniz Kaya[\s\S]*In a conversation with: Deniz Kaya/.test(prompt))
      return res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ label: "related", confidence: 0.9, reason: "A teammate from their notes." }),
              },
            },
          ],
        }),
      );
    // The second look: judge the excerpt alone (the goal itself says "checkout").
    const excerpt = messages.at(-1).content.match(/^Page excerpt: (.*)$/m)?.[1];
    const reply =
      excerpt !== undefined
        ? /checkout/.test(excerpt)
          ? { label: "related", confidence: 0.9, reason: "A chat about the checkout bug." }
          : { label: "unrelated", confidence: 0.9, reason: "Not about the checkout bug." }
        : /Maybe work/.test(messages.at(-1).content)
          ? { label: "unrelated", confidence: 0.4, reason: "Hard to tell." }
          : /Top 10 F1 crashes|\| Social/.test(messages.at(-1).content)
            ? { label: "unrelated", confidence: 0.9, reason: "Not the checkout bug." }
            : { label: "related", confidence: 0.9, reason: "The shop repo." };
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const repo = `http://127.0.0.1:${port}/repo`;
const video = `http://localhost:${port}/video`;
const chat = `http://localhost:${port}/chat`;
const compose = `http://localhost:${port}/compose`;
const side = `http://localhost:${port}/side`;
const login = `http://localhost:${port}/login`;
const docked = `http://localhost:${port}/docked`;
const thread = `http://localhost:${port}/messaging/thread/1`;
const dockedSocial = `http://localhost:${port}/docked-social`;
const knownChat = `http://localhost:${port}/known-chat`;
const centreChat = `http://localhost:${port}/centre-chat`;
const dockFeed = `http://localhost:${port}/dock-feed`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ext-e2e-"));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  viewport: { width: 420, height: 720 },
  args: ["--headless=new", `--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
let [worker] = ctx.serviceWorkers();
worker ??= await ctx.waitForEvent("serviceworker");
const ext = `chrome-extension://${new URL(worker.url()).host}`;
const errors = [];
const watch = (p) => p.on("pageerror", (e) => errors.push(String(e)));

// Settings: the fake model, and short timings so the test runs in seconds. The test
// hops between tabs to reach the popup, so fragmentation (unit-tested) is off here.
// Chrome's idle state is the machine's: the test must not depend on someone typing.
const settingsPage = await ctx.newPage();
watch(settingsPage);
await settingsPage.goto(`${ext}/options/options.html`);
await settingsPage.evaluate(async (baseUrl) => {
  const { saveModelSettings } = await import("/memory/model.js");
  // Remembered, so the key survives the restart below and the second look can call the model.
  await saveModelSettings({ provider: "meta", baseUrl, model: "fake", apiKey: "test-key" }, { remember: true });
  await chrome.storage.local.set({
    attentionConfig: {
      toleranceSec: 3,
      escalateAfterSec: 4,
      fragMinSwitches: 1000,
      idleAfterSec: 86400,
      holdSec: 2,
      labelMin: 0.1, // "This is for my task" on a site: 6 s here
    },
  });
}, `http://127.0.0.1:${port}/v1`);

// Getting started on the page: the settings page took the day's first look (Tuck
// cannot appear there), so Tuck greets on the first normal page and asks for the goal.
const repoTab = await ctx.newPage();
await repoTab.goto(repo);
const tuck = repoTab.locator("#tuck-companion");
await tuck.locator(".bubble input[name=goal]").waitFor({ timeout: 10000 });
const greeting = await tuck.locator(".bubble .text").textContent();
const greetState = await tuck.locator("svg.tuck").getAttribute("data-state");
if (shots) await repoTab.screenshot({ path: path.join(shots, "tuck-greeting.png") });
// Drag Tuck to the left: the bubble then opens rightwards.
await repoTab.waitForTimeout(600); // the slide-in
const box = await tuck.locator(".avatar").boundingBox();
await repoTab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await repoTab.mouse.down();
await repoTab.mouse.move(60, 120, { steps: 8 });
await repoTab.mouse.up();
const dragged = await tuck.locator(".avatar").boundingBox();
const bubbleAfterDrag = await tuck.locator(".bubble").boundingBox();
const formStillOpen = await tuck.locator("input[name=goal]").isVisible();
if (shots) await repoTab.screenshot({ path: path.join(shots, "tuck-dragged-left.png") });
await tuck.locator("input[name=goal]").fill("Fix the checkout bug");
await tuck.locator("input[name=step]").fill("Write the failing test");
await tuck.locator("button.start").click();
await tuck.locator(".bubble .text", { hasText: "Got it" }).waitFor();
// Tuck stays, resting; a click is a check-in wave with the goal card.
await repoTab.waitForTimeout(2500);
const restState = await tuck.locator("svg.tuck").getAttribute("data-state");
await tuck.locator(".avatar").click();
await tuck.locator(".bubble .text", { hasText: "Fix the checkout bug" }).waitFor();
const clickState = await tuck.locator("svg.tuck").getAttribute("data-state");
await tuck.locator(".bubble .close").click();
await repoTab.waitForTimeout(1500);

// A reload keeps the tab and URL but wipes what was injected: Tuck comes back, resting,
// without a new greeting or the goal form (issue #22).
await repoTab.reload();
await tuck.waitFor({ state: "attached", timeout: 10000 });
const afterReload = {
  state: await tuck.locator("svg.tuck").getAttribute("data-state"),
  formOpen: await tuck.locator("input[name=goal]").isVisible(),
  shown: await tuck.locator(".dock.in").count(),
  hosts: await repoTab.locator("#tuck-companion").count(),
};

// The popup (opened as a tab) shows the goal set on the page.
const popup = await ctx.newPage();
watch(popup);
await popup.goto(`${ext}/popup/popup.html`);
await popup.waitForSelector("#intent-view:not([hidden])");
const intentShown = await popup.textContent("#intent-title");

// Poll from node: extension pages forbid the eval that waitForFunction polling uses.
const lastTrigger = () => popup.evaluate(async () => (await chrome.storage.local.get("lastTrigger")).lastTrigger);
async function waitForNewDrift(afterId) {
  for (let i = 0; i < 60; i++) {
    const t = await lastTrigger();
    if (t?.kind === "drift" && t.id !== afterId && !t.respondedAt) return t;
    await popup.waitForTimeout(250);
  }
  throw new Error(`no new drift trigger after ${afterId}`);
}
const activeUrl = () =>
  popup.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url);
async function clickOnCard(button) {
  await popup.bringToFront();
  await popup.reload();
  await popup.waitForSelector("#trigger:not([hidden])");
  const text = await popup.textContent("#trigger-text");
  await popup.click(button);
  await popup.waitForTimeout(500);
  return text;
}

// Browse: the repo, then the video. The model judges each page once.
await repoTab.bringToFront();
await repoTab.waitForTimeout(1500);
const videoTab = await ctx.newPage();
await videoTab.goto(video);
await videoTab.bringToFront();
const drift1 = await waitForNewDrift(null);
const badge = await popup.evaluate(() => chrome.action.getBadgeText({}));
// Tuck on the video speaks at the first detection (L1): a check-in wave with the
// message. Still drifting, it turns to thinking (L2).
const onVideo = videoTab.locator("#tuck-companion");
await onVideo.locator(".bubble button[data-choice=back]").waitFor({ timeout: 2500 });
const firstState = await onVideo.locator("svg.tuck").getAttribute("data-state");
const firstText = await onVideo.locator(".bubble .text").textContent();
for (let i = 0; i < 40 && (await onVideo.locator("svg.tuck").getAttribute("data-state")) !== "thinking"; i++)
  await videoTab.waitForTimeout(250);
const nudgeState = await onVideo.locator("svg.tuck").getAttribute("data-state");
const videoAvatar = await onVideo.locator(".avatar").boundingBox();
const cardText = await onVideo.locator(".bubble .text").textContent();
if (shots) await videoTab.screenshot({ path: path.join(shots, "tuck-nudge.png") });
await onVideo.locator(".bubble button[data-choice=back]").click();
await popup.waitForTimeout(800);
if (shots) await popup.screenshot({ path: path.join(shots, "popup-trigger.png"), fullPage: true });
const backTo = await activeUrl();

// The related tab is gone: "Take me back" reopens its page.
await videoTab.bringToFront();
const drift2 = await waitForNewDrift(drift1.id);
await repoTab.close();
await clickOnCard("#take-me-back");
const reopened = await activeUrl();

// Review C1: Chrome restarts (session storage is wiped); the goal must still be watched.
await popup.evaluate(() => chrome.storage.session.clear());
await videoTab.bringToFront();
const drift4 = await waitForNewDrift(drift2.id);
await clickOnCard("#take-me-back");
const backAfterRestart = await activeUrl();

// Minor 6: going back to work on your own clears the nudge.
await videoTab.bringToFront();
const drift5 = await waitForNewDrift(drift4.id);
await ctx
  .pages()
  .find((p) => p.url() === repo)
  .bringToFront();
await popup.waitForTimeout(1500);
const selfReturn = await lastTrigger();
await popup.reload();
const cardAfterSelfReturn = await popup.isVisible("#trigger");

// "This is for my task" on the video: the next visit stays quiet.
await videoTab.bringToFront();
const drift3 = await waitForNewDrift(drift5.id);
await clickOnCard("#for-my-task");
await videoTab.bringToFront();
await videoTab.waitForTimeout(5000);
const afterLabel = await lastTrigger();

// …for a while: once the site label has run out, the video is a drift again.
await videoTab.waitForTimeout(2000);
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
const drift6 = await waitForNewDrift(drift3.id);

// Issue #5, the second look. A chat about the goal on a social page: the title says
// unrelated, the excerpt says work, so no nudge. A draft typed into its reply box, then
// left, must never reach the model.
const chatTab = await ctx.newPage();
await chatTab.goto(chat);
await chatTab.fill("#reply", DRAFT);
await chatTab.evaluate(() => document.activeElement.blur());
await chatTab.bringToFront();
await chatTab.waitForTimeout(6000);
const afterChat = await lastTrigger();

// Typing on an unrelated page holds the nudge twice (2 s each here), then it comes at L1.
const composeTab = await ctx.newPage();
await composeTab.goto(compose);
await composeTab.bringToFront();
await composeTab.locator("#tuck-companion").waitFor({ state: "attached" }); // Tuck there: typing is noted
await composeTab.click("#reply");
await composeTab.keyboard.type("brb");
const typingFrom = Date.now();
const drift7 = await waitForNewDrift(afterChat.id);
const heldMs = Date.now() - typingFrom;

// Review: the chat box at the bottom is focused, but nobody types. The page is judged by
// the feed in the middle: the nudge comes, with no hold. Typing in the box then makes
// the next look read the chat, which is work: the drift ends. A fresh drift, so only a
// hold could delay the word, not the spacing between words of one drift.
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "respond", choice: "back" }));
const sideTab = await ctx.newPage();
await sideTab.goto(side);
await sideTab.bringToFront();
await sideTab.locator("#tuck-companion").waitFor({ state: "attached" });
await sideTab.click("#reply");
const sideFrom = Date.now();
const driftSide = await waitForNewDrift(drift7.id);
const sideMs = Date.now() - sideFrom;
await sideTab.keyboard.type("on it");
await sideTab.waitForTimeout(6000);
const afterTyping = await lastTrigger();

// A page with a password field is not read: the nudge comes without an excerpt.
const loginTab = await ctx.newPage();
await loginTab.goto(login);
await loginTab.bringToFront();
const drift8 = await waitForNewDrift(driftSide.id);

// Where the person works on the page (issue #9): the conversation last touched, by its
// heading. Each answer is read from the exported log, the input a replay sees.
const surfaceAt = async (url, wanted) => {
  for (let i = 0; i < 40; i++) {
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
    const { events } = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "export-log" }));
    const surface = events.filter((e) => e.type === "context" && e.url === url).at(-1)?.surface;
    if (surface?.kind === wanted) return surface;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no ${wanted} surface on ${url}`);
};
const dockedTab = await ctx.newPage();
await dockedTab.goto(docked);
await dockedTab.bringToFront();
await dockedTab.locator("#tuck-companion").waitFor({ state: "attached" });
const dockedStart = await surfaceAt(docked, "page");
await dockedTab.click("#docked-box");
const dockedChat = await surfaceAt(docked, "conversation");
// The feed scrolls under the chat: the focus stays in the box, the person does not.
await dockedTab.mouse.move(40, 200);
await dockedTab.mouse.wheel(0, 200);
const dockedFeed = await surfaceAt(docked, "page");
const focusStayed = await dockedTab.evaluate(
  () => document.getElementById("outlet").shadowRoot.activeElement?.id === "docked-box",
);
await dockedTab.click("#docked-box");
await surfaceAt(docked, "conversation");
await dockedTab.click("#comment");
const dockedComment = await surfaceAt(docked, "page");
// A chat touched and then closed is a page again.
await dockedTab.click("#docked-box");
await surfaceAt(docked, "conversation");
await dockedTab.evaluate(() => document.getElementById("outlet").shadowRoot.getElementById("docked-chat").remove());
const dockedClosed = await surfaceAt(docked, "page");
await dockedTab.goto(thread);
await dockedTab.locator("#tuck-companion").waitFor({ state: "attached" });
await dockedTab.click("#thread-box");
const threadChat = await surfaceAt(thread, "conversation");
// A reload wipes what the page noted: it is watched again, with the tab and URL unchanged.
await dockedTab.reload();
await surfaceAt(thread, "page");
await dockedTab.click("#thread-box");
const threadAfterReload = await surfaceAt(thread, "conversation");
await dockedTab.goto(`http://localhost:${port}/docs/chat-api`);
await dockedTab.locator("#tuck-companion").waitFor({ state: "attached" });
await dockedTab.click("#feedback");
await popup.waitForTimeout(500);
const articleSurface = await surfaceAt(`http://localhost:${port}/docs/chat-api`, "page");
await dockedTab.close();

// A chat's answer stays with the chat (issue #9): "This is for my task" in the conversation
// silences it, and the feed on the same URL still drifts.
const socialTab = await ctx.newPage();
await socialTab.goto(dockedSocial);
await socialTab.bringToFront();
await socialTab.locator("#tuck-companion").waitFor({ state: "attached" });
await socialTab.click("#social-box");
await surfaceAt(dockedSocial, "conversation");
// The budget carries over from the last page, so a first word can come before the chat is
// touched. It is about the page; the answer below has to be about the chat.
let driftInChat = await waitForNewDrift(drift8.id);
while (driftInChat.evidence.surface?.kind !== "conversation") driftInChat = await waitForNewDrift(driftInChat.id);
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "respond", choice: "related" }));
const chatAfterAnswer = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "export-log" }));
// Away from Tuck, top left here: touching Tuck says nothing about where the person works.
await socialTab.mouse.move(40, 400);
await socialTab.mouse.wheel(0, 200);
await surfaceAt(dockedSocial, "page");
const driftOnFeed = await waitForNewDrift(driftInChat.id);
await socialTab.click("#social-box");
await surfaceAt(dockedSocial, "conversation");
await popup.waitForTimeout(500);
const backInChat = await popup.evaluate(async () => {
  const { events } = await chrome.runtime.sendMessage({ type: "export-log" });
  return events.filter((e) => e.type === "context").at(-1);
});
await socialTab.close();

// Notes decide what a page means (issue #8). The same chat, the same minute: with nothing
// known it is a drift; once the notes name the person it is work, with no nudge; and the
// feed under it still drifts.
const knownTab = await ctx.newPage();
await knownTab.goto(knownChat);
await knownTab.bringToFront();
await knownTab.locator("#tuck-companion").waitFor({ state: "attached" });
await knownTab.click("#known-box");
await surfaceAt(knownChat, "conversation");
let driftUnknown = await waitForNewDrift(driftOnFeed.id);
while (driftUnknown.evidence.surface?.kind !== "conversation") driftUnknown = await waitForNewDrift(driftUnknown.id);
const askedBefore = calls.length;
await settingsPage.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  const memory = await Memory.open();
  const iso = (d) => new Date(d - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const today = iso(Date.now());
  await memory.importFiles([
    {
      path: "notes/log/2026/visa.md",
      text: [
        "---",
        'title: "Send the visa papers"',
        "kind: todo",
        "topic: errands",
        `date: ${iso(Date.now() - 86400000)}`,
        "source: test",
        "id: visa01",
        "---",
        "",
        "- **Context:** The consulate wants them.",
        "- **Decision/Result:** Papers are ready.",
        "- **Evidence:** none",
        `- **Next action:** Post them, deadline ${today}`,
      ].join("\n"),
    },
    {
      path: "notes/log/2026/note.md",
      text: [
        "---",
        'title: "Deniz Kaya joins the shop work"',
        "kind: fact",
        "topic: shop",
        "date: 2026-10-30",
        "source: test",
        "id: abc123",
        "---",
        "",
        "- **Context:** Working with Deniz Kaya on the shop bug.",
        "- **Decision/Result:** We pair every day.",
        "- **Evidence:** none",
        "- **Next action:** none",
      ].join("\n"),
    },
  ]);
  await chrome.runtime.sendMessage({ type: "memory-changed" });
});
await knownTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await popup.waitForTimeout(6000);
const knownEvents = (await popup.evaluate(() => chrome.runtime.sendMessage({ type: "export-log" }))).events;
const knownVerdict = knownEvents
  .filter((e) => e.type === "relevance" && /\|conversation\|deniz kaya$/.test(e.key))
  .at(-1);
const afterKnown = await lastTrigger();
const notesPrompt = calls.slice(askedBefore).find((m) => /From their own notes:/.test(m.at(-1).content));
await knownTab.mouse.move(40, 400);
await knownTab.mouse.wheel(0, 200);
await surfaceAt(knownChat, "page");
const driftKnownFeed = await waitForNewDrift(afterKnown.id);
await knownTab.close();

// Issue #23: a chat in an open shadow root, nothing typed. In the middle of the window and
// never touched, its text is what the excerpt reads, not the page around it; the draft in
// its box never reaches the model.
const workTab = await ctx.newPage();
await workTab.goto(repo);
await workTab.bringToFront();
await workTab.waitForTimeout(2500); // work first: the budget from the last page runs out
const beforeCentre = await lastTrigger();
const centreTab = await ctx.newPage();
await centreTab.goto(centreChat);
await centreTab.bringToFront();
await centreTab.waitForTimeout(6000);
const afterCentre = await lastTrigger();
await centreTab.close();

// The chat docked under a feed: touched, not typed in, it is where the person works, so
// its text is read. Touching the feed ends that, and the page is judged by the feed.
await workTab.bringToFront();
await workTab.waitForTimeout(2500);
const beforeDock = await lastTrigger();
const dockTab = await ctx.newPage();
await dockTab.goto(dockFeed);
await dockTab.bringToFront();
await dockTab.locator("#tuck-companion").waitFor({ state: "attached" });
await dockTab.click("#dock-box");
await dockTab.waitForTimeout(6000);
const afterDockChat = await lastTrigger();
await dockTab.mouse.move(100, 300);
await dockTab.mouse.wheel(0, 100);
const driftDockFeed = await waitForNewDrift(afterDockChat.id);
await dockTab.close();
await workTab.close();

// Review: reading turned off. The chat's earlier "work" verdict no longer counts, and
// nothing is read: the chat page is a drift again.
await settingsPage.evaluate(() => chrome.storage.local.set({ pageReading: { enabled: false } }));
await chatTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
const driftOff = await waitForNewDrift(driftDockFeed.id);

// Whose turn it is in a coding agent (#11): while it works the same drifting page is a
// wait; when it stops Tuck says so, once.
const agentSays = (status) =>
  popup.evaluate((s) => chrome.runtime.sendMessage({ type: "agent-status", status: s, session: "s1" }), status);
const agentTab = await ctx.newPage();
await agentTab.goto(dockedSocial);
await agentTab.bringToFront();
await agentSays("working");
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await agentTab.waitForTimeout(500);
const beforeWait = await lastTrigger();
await agentTab.waitForTimeout(6000);
const duringWait = await lastTrigger();
const waitStatus = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }));
await agentSays("waiting_for_user");
await agentSays("waiting_for_user");
await agentTab.locator("#tuck-companion").waitFor({ state: "attached" });
await agentTab.waitForTimeout(500);
const agentWord = await lastTrigger();
const agentBubble = await agentTab.locator("#tuck-companion .bubble").innerText();
await agentTab.close();
await agentSays("unknown");
await chatTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));

// Review I1: changing the goal closes the old one; Done leaves no goal behind.
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "set-intent", title: "Write the demo script" }));
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "complete-intent" }));
const afterDone = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }));

// A finished goal is a natural moment: Tuck names what is due, once, and "Done" holds (#10).
const answer = chatTab.locator('[data-reminder="done"]');
await answer.waitFor({ state: "attached" });
const reminderText = await chatTab.locator("#tuck-companion .reminder").innerText();
if (shots) await chatTab.screenshot({ path: path.join(shots, "tuck-reminder.png") });
const loopsAfterSaid = await popup.evaluate(async () => (await chrome.storage.local.get("loops")).loops);
await answer.click();
await chatTab.waitForTimeout(300);
const loopsAfterDone = await popup.evaluate(async () => (await chrome.storage.local.get("loops")).loops);
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "set-intent", title: "Write the demo script" }));
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "complete-intent" }));
await chatTab.waitForTimeout(500);
const reminderAgain = await chatTab.locator('[data-reminder="done"]').count();

// "No, take me back" on a page Tuck was unsure about is remembered, and settings forget it.
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "set-intent", title: "Write the demo script" }));
const maybeTab = await ctx.newPage();
await maybeTab.goto(`http://localhost:${port}/maybe`);
await maybeTab.bringToFront();
// The chat page in front until now can still get a word first.
let driftMaybe = await waitForNewDrift(driftOff.id);
while (!driftMaybe.evidence.url.endsWith("/maybe")) driftMaybe = await waitForNewDrift(driftMaybe.id);
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "respond", choice: "back" }));
const learned = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-labels" }));
await maybeTab.close();
await settingsPage.reload();
await settingsPage.locator("#label-list button").first().waitFor();
const labelLines = await settingsPage.locator("#label-list").innerText();
await settingsPage.locator("#label-list button").first().click();
await settingsPage.waitForTimeout(300);
const learnedAfter = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-labels" }));

// "This is for my task" on a third day lasts, and writes a preference to memory; Forget in
// settings takes that back too, so the model stops reading it (#25). The two earlier days
// are seeded: a test cannot wait for them.
const lastingKey = await popup.evaluate(async (url) => {
  const { openStore } = await import("/attention/store.js");
  const { labelKeys, hostOf } = await import("/attention/relevance.js");
  const { dayKey } = await import("/attention/intents.js");
  const { DEFAULTS } = await import("/attention/config.js");
  const st = await openStore();
  const { topic } = await st.activeIntent();
  const title = "Top 10 F1 crashes - Video";
  const key = labelKeys(topic, url, title)[0];
  const day = (n) => dayKey(Date.now() - n * 86400000, DEFAULTS);
  const ts = Date.now() - 86400000;
  await st.putLabel({ key, label: "related", topic, host: hostOf(url), title, ts, days: [day(2), day(1)], until: ts });
  return key;
}, video);
const lastingTab = await ctx.newPage();
await lastingTab.goto(video);
await lastingTab.bringToFront();
let driftLasting = await waitForNewDrift(driftMaybe.id);
while (driftLasting.evidence.url !== video) driftLasting = await waitForNewDrift(driftLasting.id);
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "respond", choice: "related" }));
const preferences = (key) =>
  popup.evaluate(async (key) => {
    const { openStore } = await import("/attention/store.js");
    const { Memory } = await import("/memory/index.js");
    const label = await (await openStore()).getLabel(key);
    const hits = await (await Memory.open()).recall("localhost counts as work");
    return { label, titles: hits.filter((h) => h.item.kind === "preference").map((h) => h.title) };
  }, key);
const lasting = await preferences(lastingKey);
await lastingTab.close();
await settingsPage.reload();
const lastingRow = settingsPage.locator("#label-list .row", { hasText: "Top 10 F1 crashes" });
await lastingRow.locator("button").click();
await settingsPage.waitForTimeout(300);
const forgotten = await preferences(lastingKey);
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "complete-intent" }));

// Issue #29: the to-do list is what the task node kept from the open loops, the first 7 in
// sight. A note to keep watching and a task a later note closed are not on it, and Not a
// task holds over a re-import, which asks the model about nothing it has already read.
const notes = (() => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const note = (id, kind, topic, date, title, next) => ({
    path: `notes/log/2026/${id}.md`,
    text: [
      "---",
      `title: "${title}"`,
      `kind: ${kind}`,
      `topic: ${topic}`,
      `date: ${date}`,
      "source: test",
      `id: ${id}`,
      "---",
      "",
      "- **Context:** Invented for the test.",
      "- **Decision/Result:** Noted.",
      "- **Evidence:** none",
      `- **Next action:** ${next}`,
    ].join("\n"),
  });
  return [
    ...Array.from({ length: 9 }, (_, i) =>
      note(`err${i + 1}`, "todo", "errands", day(i + 2), `Errand ${i + 1}`, "Do it"),
    ),
    note("watch1", "fact", "shop", day(3), "Cart conversion dipped", "Keep an eye on the conversion rate"),
    note("venue1", "todo", "party", day(6), "Book the venue", "Call the hall"),
    note("venue2", "event", "party", day(4), "The hall is booked for Saturday", "none"),
  ];
})();
const importNotes = () =>
  settingsPage.evaluate(async (files) => {
    const { Memory } = await import("/memory/index.js");
    await (await Memory.open()).importFiles(files);
  }, notes);
const reread = async () => {
  await settingsPage.click("#reread");
  await settingsPage.waitForFunction(() => !/^Reading/.test(document.getElementById("profile-status").textContent));
  await settingsPage.waitForFunction(() => !/^Reading/.test(document.getElementById("task-status").textContent));
  await settingsPage.waitForTimeout(500);
};
await settingsPage.bringToFront();
await importNotes();
await reread();
const taskRows = await settingsPage.locator("#task-list .row").count();
const showAllLabel = await settingsPage.locator("#all-tasks").innerText();
await settingsPage.click("#all-tasks");
await settingsPage.waitForTimeout(300);
const allTaskText = await settingsPage.locator("#task-list").innerText();
const askedTasks = taskCalls.length;
await settingsPage
  .locator("#task-list .row", { hasText: "Run errand 1" })
  .getByRole("button", { name: "Not a task" })
  .click();
await settingsPage.waitForTimeout(300);
await importNotes();
await reread();
const taskTextAfter = await settingsPage.locator("#task-list").innerText();
const askedAgain = taskCalls.length - askedTasks;

// The exported event log.
await settingsPage.bringToFront();
const log = await settingsPage.evaluate(() => chrome.runtime.sendMessage({ type: "export-log" }));
const types = new Set(log.events.map((e) => e.type));
if (shots) {
  await settingsPage.reload();
  await settingsPage.waitForTimeout(500);
  await settingsPage.screenshot({ path: path.join(shots, "settings.png"), fullPage: true });
}

await ctx.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });

assert.deepEqual(errors, []);
assert.equal(greeting, "Hi. What are we working on today?");
assert.equal(greetState, "checkin");
assert.equal(restState, "resting", "Tuck rests on the page once the goal is set");
assert.deepEqual(
  afterReload,
  { state: "resting", formOpen: false, shown: 1, hosts: 1 },
  "after a reload Tuck is back on the page, resting, once",
);
assert.equal(clickState, "checkin", "clicking Tuck is a check-in");
assert.ok(dragged.x < 100, `dragged to the left: ${dragged.x}`);
assert.ok(bubbleAfterDrag.x >= dragged.x, "on the left, the bubble opens rightwards");
assert.ok(formStillOpen, "a drag is not a click");
assert.ok(videoAvatar.x < 100, `Tuck remembers where it was put: ${videoAvatar.x}`);
assert.equal(intentShown, "Fix the checkout bug");
assert.equal(drift1.level, 1);
assert.equal(firstState, "checkin", "the first detection is a visible wave");
assert.equal(firstText, "Still on the video? Back to the failing test.", "Tuck says the model's line");
assert.ok(nudgeCalls.length >= 1);
assert.match(nudgeCalls[0][1].content, /Site now: localhost/);
assert.match(nudgeCalls[0][1].content, /Next step: Write the failing test/);
assert.equal(nudgeState, "thinking");
assert.match(calls[0].at(-1).content, /Goal: Fix the checkout bug/);
const looks = calls.filter((m) => /excerpt/.test(m[0].content));
const judged = calls.filter((m) => !/excerpt/.test(m[0].content));
// Under the first goal: a later goal judges it afresh (the Forget step, #25).
const videoCalls = judged.filter((m) =>
  /Goal: Fix the checkout bug[\s\S]*Top 10 F1 crashes/.test(m.at(-1).content),
).length;
assert.equal(videoCalls, 1, `the video is judged once, then cached (${videoCalls} calls)`);
assert.ok(["·", "!"].includes(badge), `badge: ${badge}`);
assert.equal(cardText, "Still on the video? Back to the failing test.", "L2 uses the drafted line too");
assert.equal(backTo, repo);
assert.equal(reopened, repo);
assert.equal(afterLabel.id, drift3.id, "no new trigger on a page marked as work");
assert.equal(afterLabel.choice, "related");
assert.equal(drift6.evidence.url, video, "a site marked as work for one visit is a drift again later");
// The second look.
assert.equal(afterChat.id, drift6.id, "no nudge on a chat about the goal");
const chatLook = looks.find((m) => /Page title: Messages \| Social/.test(m.at(-1).content));
assert.ok(chatLook, "the chat was looked at");
assert.match(chatLook.at(-1).content, /Page excerpt: .*splices the wrong index/);
assert.ok(!calls.some((m) => JSON.stringify(m).includes("hunter2")), "a typed draft never reaches the model");
assert.ok(
  log.events.some((e) => e.type === "second_look" && e.label === "related" && e.source === "look"),
  "the chat's verdict is in the log",
);
assert.ok(
  log.events.some((e) => e.type === "llm" && e.node === "secondLook" && e.chars > 0 && !("text" in e)),
  "the log keeps the look's size, never its text",
);
assert.equal(drift7.evidence.url, compose);
assert.equal(drift7.level, 1, "after the holds the first word is L1");
assert.ok(heldMs >= 3500, `typing held the nudge (${heldMs} ms)`);
assert.ok(
  log.events.filter((e) => e.type === "second_look" && e.composing).length >= 3,
  "typing was seen at each look",
);
assert.equal(driftSide.evidence.url, side, "a focused chat box does not speak for the feed");
assert.ok(sideMs < 3500, `no hold without typing (${sideMs} ms)`);
assert.equal(afterTyping.id, driftSide.id, "typing in the chat box: the chat is read, it is work, no more nudges");
const sideLooks = looks.filter((m) => /Page title: Home \| Social/.test(m.at(-1).content));
assert.ok(
  sideLooks.some((m) => /Page excerpt: .*Five lessons/.test(m.at(-1).content)),
  "without typing, the middle (the feed) was read",
);
const typedLook = sideLooks.find((m) => /Page excerpt: .*splices the wrong index/.test(m.at(-1).content));
assert.ok(typedLook, "with typing, the chat around the box was read");
assert.doesNotMatch(typedLook.at(-1).content, /Five lessons/, "the chat, not the whole page");
assert.ok(!sideLooks.some((m) => /on it/.test(m.at(-1).content.split("Page excerpt:")[1] ?? "")), "not the draft");
assert.equal(drift8.evidence.url, login);
assert.deepEqual(dockedStart, { kind: "page", labels: [] }, "a chat merely open is not where the person works");
assert.deepEqual(
  dockedChat,
  { kind: "conversation", labels: ["Ali Demir"] },
  "the chat in a shadow root, by its heading",
);
assert.deepEqual(dockedFeed, { kind: "page", labels: [] }, "scrolling the feed ends the conversation");
assert.equal(focusStayed, true, "with the focus still in the chat's box");
assert.deepEqual(dockedComment, { kind: "page", labels: [] }, "a comment box on a feed is not a conversation");
assert.deepEqual(dockedClosed, { kind: "page", labels: [] }, "a closed chat is a page");
assert.deepEqual(threadChat, { kind: "conversation", labels: ["Ali Demir"] }, "the full messaging page");
assert.equal(threadAfterReload.kind, "conversation", "still watched after a reload");
assert.equal(articleSurface.kind, "page", "an article about chat is not a conversation");
assert.ok(
  !log.events.some((e) => JSON.stringify(e.surface ?? "").includes("secret plan")),
  "only the heading is read, not message text in labels",
);
assert.equal(driftInChat.evidence.surface.kind, "conversation", "the nudge says it was about the chat");
const chatLabel = chatAfterAnswer.events.filter((e) => e.type === "feedback" && e.kind === "label").at(-1).payload;
assert.match(chatLabel.key, /\|conversation\|ali demir$/, "the answer labels the conversation, not the site");
assert.equal(driftOnFeed.evidence.url, dockedSocial, "the feed on the same URL still drifts");
assert.equal(driftOnFeed.evidence.surface.kind, "page");
assert.equal(backInChat.source, "label", "back in the chat, its label still holds");
assert.equal(driftUnknown.evidence.url, knownChat, "with nothing known, the chat is a drift");
assert.equal(knownVerdict?.label, "related", "once the notes name the person, the same chat is work");
assert.equal(afterKnown.id, driftUnknown.id, "and Tuck says nothing more about it");
assert.match(notesPrompt.at(-1).content, /Working with Deniz Kaya/, "the note itself reached the model");
assert.equal(driftKnownFeed.evidence.surface.kind, "page", "the feed under the chat still drifts");
assert.equal(driftOff.evidence.url, chat, "with reading off, a cached verdict does not count");
assert.ok(
  log.events.some((e) => e.type === "second_look" && e.skipped === "settings"),
  "with reading off, nothing is read",
);
const centreLooks = looks.filter((m) => /Page title: Network \| Social/.test(m.at(-1).content));
assert.ok(
  centreLooks.some((m) => /Page excerpt: .*splices the wrong index/.test(m.at(-1).content)),
  "a chat in a shadow root in the middle of the window is read, nothing typed",
);
assert.ok(!centreLooks.some((m) => /Five lessons/.test(m.at(-1).content)), "and not the page around it");
assert.equal(afterCentre.id, beforeCentre.id, "a work chat in the middle of the window gets no nudge");
const dockLooks = looks.filter((m) => /Page title: Updates \| Social/.test(m.at(-1).content));
assert.ok(
  dockLooks.some((m) => /Page excerpt: .*splices the wrong index/.test(m.at(-1).content)),
  "the chat last touched is read, nothing typed",
);
assert.equal(afterDockChat.id, beforeDock.id, "no nudge while the person is in the chat");
assert.equal(driftDockFeed.evidence.surface?.kind, "page", "scrolling the feed ends the conversation");
assert.equal(driftDockFeed.evidence.url, dockFeed, "the feed with a chat left open is still judged as a feed");
assert.ok(!looks.some((m) => /Sign in \| Social/.test(m.at(-1).content)), "the login page was not read");
assert.ok(
  log.events.some((e) => e.type === "second_look" && e.skipped === "password"),
  "the skip is in the log",
);
assert.ok(
  looks.some((m) => /Page title: Top 10 F1 crashes/.test(m.at(-1).content)),
  "the video was looked at before its nudges",
);
assert.equal(drift4.kind, "drift", "drift is still caught after a restart");
assert.equal(backAfterRestart, repo, "Take me back still works after a restart");
assert.equal(duringWait.id, beforeWait.id, "no nudge while the agent works");
assert.equal(waitStatus.engine.state, "agent_working");
assert.equal(agentWord.kind, "agent");
assert.match(agentBubble, /Muse is waiting on you\./);
assert.equal(afterDone.intent, null, "no stale goal after change + done");
assert.match(reminderText, /Due today\. Still on your list\?/, "the deadline in Tuck's words");
assert.match(reminderText, /Send the visa papers/);
assert.ok(loopsAfterSaid.visa01.saidOn, "said once it is on screen");
assert.ok(loopsAfterDone.visa01.doneAt, "Done is remembered");
assert.equal(reminderAgain, 0, "and it does not come back");
assert.equal(driftMaybe.evidence.unsure, true, "Tuck asks on a page it is unsure about");
assert.equal(askedTasks, 1, "eleven open loops, one call");
assert.equal(taskRows, 7, "the first 7 in sight");
assert.match(showAllLabel, /Show all 9/, "the rest behind Show all");
assert.match(allTaskText, /Run errand 1\b[\s\S]*Run errand 9/, "the node's titles, newest first");
assert.doesNotMatch(allTaskText, /conversion|venue|Book the/i, "no watch note, and no task a later note closed");
assert.doesNotMatch(taskTextAfter, /Run errand 1\b/, "Not a task holds over a re-import");
assert.match(taskTextAfter, /Run errand 2/);
assert.equal(askedAgain, 0, "a re-import with nothing new asks nothing");
assert.ok(
  taskCalls.every((m) => !m.at(-1).content.includes(DRAFT)),
  "the task node sees only notes",
);
const no = learned.find((l) => l.label === "unrelated");
assert.equal(no?.host, "localhost", "the no is remembered");
assert.match(labelLines, /localhost.*not work/, "settings shows what was learned");
assert.ok(learnedAfter.length < learned.length, "and can forget it");
assert.equal(driftLasting.evidence.url, video);
assert.equal(lasting.label.until, null, "given on a third day, the site label lasts");
assert.ok(lasting.label.memoryEntry?.id, "the label keeps the memory entry it wrote");
assert.equal(lasting.titles.length, 1, `one preference written: ${lasting.titles}`);
assert.match(lasting.titles[0], /^localhost counts as work for /);
assert.equal(forgotten.label, undefined, "Forget removes the label");
assert.deepEqual(forgotten.titles, [], "and the preference: recall no longer finds it");
assert.equal(selfReturn.id, drift5.id);
assert.equal(selfReturn.resolvedBy, "self", "a drift ends on its own when you go back to work");
assert.equal(cardAfterSelfReturn, false, "no stale card in the popup");
for (const t of ["context", "relevance", "llm", "state", "trigger", "response", "feedback", "session"])
  assert.ok(types.has(t), `log has ${t}: ${[...types]}`);
assert.ok(!log.events.some((e) => String(e.url ?? "").startsWith("chrome-extension:")), "no extension URLs in the log");
console.log("extension e2e: ok");

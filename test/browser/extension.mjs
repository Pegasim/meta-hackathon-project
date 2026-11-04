// End-to-end: the real extension in Chromium against a local fake model.
// Goal from the popup → related page → unrelated page → drift trigger, badge and
// popup card → "Take me back" (also when the related tab was closed) → "This is
// for my task" silences that page, for a while → the second look (issue #5): a work
// chat on a social page is not a drift, typing holds the nudge, a chat box left
// focused does not speak for the feed but typing in it does, a page with a password
// field is not read → a goal that ran out is summed up in memory and in the next
// greeting (#46) → the exported event log holds it all.
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
const greetCalls = [];
const agentCalls = [];
const taskCalls = [];
const pairCalls = []; // which open loops are one commitment (#47)
const loopCalls = []; // the agent loop's requests, with their tools (#81)
let loopSlowMs = 0; // how long the fake model takes to answer the agent loop
let tasksCut = false; // the task node's replies are cut at the token limit (#43)
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
  if (req.url === "/tax") return page("Tax form");
  if (req.url === "/notes") return page("Reading notes");
  if (req.url === "/recipes") return page("Recipes");
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
  // The same again under another title (its own verdicts), for a region read that runs out (#38).
  if (req.url === "/dock-feed-slow")
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(
        `<title>Digest | Social</title><main style="padding-bottom:300px">${feedText}</main>` +
          chatRoot("slow-box", "position:fixed;bottom:0;right:0;width:190px;background:#eee"),
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
    const { messages, tools } = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    // The agent loop (#81): it reads first, then finishes with the moment's tool.
    if (tools?.length) {
      loopCalls.push({ messages, tools: tools.map((t) => t.function.name) });
      return setTimeout(() => res.end(JSON.stringify(agentReply(messages))), loopSlowMs);
    }
    // Tuck's words (agent/nudge.js).
    if (/You are Tuck/.test(messages[0].content)) {
      // The greeting after a goal (#46) takes a while, so a greeting right at a restart
      // cannot wait for it.
      if (/new session/.test(messages.at(-1).content)) {
        greetCalls.push(messages);
        const message = "Two hours on the launch plan last time. Pick it up?";
        const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message }) } }] });
        return setTimeout(() => res.end(body), 2000);
      }
      // Tuck's words about Muse (#67), said only when written ahead of the word.
      if (/Situation: Muse/.test(messages.at(-1).content)) {
        agentCalls.push(messages);
        const message = /may still be waiting/.test(messages.at(-1).content)
          ? "Muse may still need you. Want to check?"
          : "Muse finished. Back to the failing test?";
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message }) } }] }));
      }
      nudgeCalls.push(messages);
      const message = "Still on the video? Back to the failing test.";
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message }) } }] }));
    }
    // The task list (agent/tasks.js): a note to keep watching is no task, a later note that
    // says "booked" closes the venue, and every other entry is a task, named anew.
    if (/short to-do list/.test(messages[0].content)) {
      if (tasksCut)
        return res.end(
          JSON.stringify({
            choices: [{ message: { content: null }, finish_reason: "length" }],
            usage: { completion_tokens_details: { reasoning_tokens: 3998 } },
          }),
        );
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
    // Which tasks are one commitment (agent/tasks.js, #47): the same place on both sides.
    if (/same commitment/.test(messages[0].content)) {
      pairCalls.push(messages);
      const pairs = messages
        .at(-1)
        .content.split("\n\n")
        .filter((b) => /^\d+\.\n/.test(b))
        .map((b) => {
          const [a, c] = b.split(/\n {3}B: /);
          const place = (t) => (/lyon/i.test(t) ? "lyon" : /rome/i.test(t) ? "rome" : null);
          return { n: Number(b.match(/^\d+/)[0]), same: !!place(a) && place(a) === place(c) };
        });
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ pairs }) } }] }));
    }
    calls.push(messages);
    // A page for something else on the to-do list.
    const prompt = messages.at(-1).content;
    if (/Their other commitments:[\s\S]*Page title: Tax form/.test(prompt))
      return res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ label: "other_commitment", confidence: 0.9, reason: "Their other task." }),
              },
            },
          ],
        }),
      );
    // Notes that name the person spoken to: that conversation is work.
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
    // Issue #38: this page's own verdict takes a while, as a real model's can (4-13 s), so
    // the person is in the chat before the first look at the page is read.
    const slow = excerpt === undefined && /Page title: Digest \| Social/.test(prompt);
    setTimeout(
      () => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] })),
      slow ? 2500 : 0,
    );
  });
});
// The fake model's turn in the agent loop: one tool call per reply, by the moment's prompt.
function agentReply(messages) {
  const system = messages[0].content;
  const results = messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  const goal = (messages[1].content.match(/^[^:\n]+: (.*)$/m)?.[1] ?? "").toLowerCase();
  const call = (name, args = {}) => ({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: `t${messages.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  if (/just set a goal/.test(system)) {
    if (!results.length) return call("recall_notes", { query: goal });
    const notes = results.flatMap((r) => r.notes ?? []);
    if (!notes.length) return call("no_plan", { reason: "nothing in the notes" });
    // #91: a plan naming a merged PR (41) and an open one (12) of the listed repository.
    if (notes.some((n) => /Shop release/.test(n.title)))
      return call("make_plan", {
        steps: [
          { step: "Review PR #41 for the shop release", minutes: 15 },
          { step: "Review PR #12 for the shop release", minutes: 15 },
          { step: "Write the shop release notes", minutes: 20 },
        ],
      });
    const rules = notes.some((n) => /Demo video rules/.test(n.title));
    return call("make_plan", {
      steps: rules
        ? [
            { step: "Write a 3-minute demo script", minutes: 30 },
            { step: "Record the demo video in one take", minutes: 30 },
            { step: "Check no API key is on screen", minutes: 10 },
          ]
        : [
            { step: `Open the notes on ${goal}`, minutes: 10 },
            { step: `Do the first part of ${goal}`, minutes: 30 },
            { step: `Check ${goal} works`, minutes: 15 },
          ],
      ...(rules && { watch_out: "Never show the API key on screen" }),
    });
  }
  // The goal chat: the checkout bug is made concrete with a first step; anything else is kept.
  if (/just told you what they want/.test(system)) {
    if (/They have no notes/.test(system) || !/checkout bug/.test(goal))
      return call("keep_goal", { reply: "Okay. What will you do first?" });
    if (!results.length) return call("recall_notes", { query: goal });
    return call("propose_goal", { title: "Fix the checkout bug", step: "Write the failing checkout test" });
  }
  if (/just wrote to you/.test(system)) {
    const wrote = messages[1].content.match(/They wrote: (.*)$/m)?.[1] ?? "";
    return call("propose_step", { step: wrote, minutes: 10 });
  }
  if (/stuck on their goal/.test(system)) {
    if (!results.length) return call("goal");
    if (results.length === 1) return call("recent_activity");
    return call("propose_step", {
      step: `Write the first lines of the ${goal.split(" ").slice(-2).join(" ")}`,
      minutes: 10,
    });
  }
  if (!results.length) return call("list_tasks");
  return call("suggest_next", { message: "Nice work. On to the next thing?" });
}

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
const dockFeedSlow = `http://localhost:${port}/dock-feed-slow`;

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
  // The first-run notes question (asked once after the key) is not what this test drives.
  await chrome.storage.local.set({
    notesAsked: true,
    attentionConfig: {
      toleranceSec: 3,
      escalateAfterSec: 4,
      agentAskAgainSec: 4,
      fragMinSwitches: 1000,
      idleAfterSec: 86400,
      holdSec: 2,
      labelMin: 0.1, // "This is for my task" on a site: 6 s here
    },
  });
}, `http://127.0.0.1:${port}/v1`);

// Waits for the goal box in Tuck's greeting. Under CPU load the greeting still shows within
// about a second (issue #52, 10 of 10 runs beside 16 busy cores), so a timeout here means a
// greeting that never came, not a slow one: it then says what the worker held.
async function greetingShown(tuck) {
  try {
    await tuck.locator(".bubble input[name=goal]").waitFor({ timeout: 10000 });
  } catch (err) {
    const held = await settingsPage
      .evaluate(async () => {
        const { openStore } = await import("/attention/store.js");
        const { pendingGreeting, engine } = await chrome.storage.session.get(["pendingGreeting", "engine"]);
        const events = (await (await openStore()).eventsSince(Date.now() - 60000)).slice(-12);
        return {
          pendingGreeting,
          engine: engine && { state: engine.state, intent: engine.intent?.title, url: engine.current?.url },
          events: events.map((e) => [e.type, e.kind ?? e.label ?? e.to ?? "", e.url ?? ""].join(" ")),
        };
      })
      .catch((e) => String(e));
    throw new Error(`${err.message}\nno greeting; the worker held: ${JSON.stringify(held, null, 1)}`);
  }
}

// Getting started on the page: the settings page took the day's first look (Tuck
// cannot appear there), so Tuck greets on the first normal page and asks for the goal.
const repoTab = await ctx.newPage();
await repoTab.goto(repo);
const tuck = repoTab.locator("#tuck-companion");
await greetingShown(tuck);
const greeting = await tuck.locator(".bubble .text").textContent();
const greetState = await tuck.locator("svg.tuck").getAttribute("data-pose");
// The default skin is the pastel kitten, a sprite skin: its greeting plays the waving strip.
const greetStrip = await tuck.locator("svg.tuck image.tuck__strip").getAttribute("href");
// The bubble wears the skin's light palette (kitten), from the theme variables alone.
const bubbleLook = await tuck.locator(".bubble").evaluate((b) => {
  const css = getComputedStyle;
  const start = b.querySelector("button.start");
  return {
    bg: css(b).backgroundColor,
    primaryBg: css(start).backgroundColor,
    styleText: b.getRootNode().querySelector("style").textContent,
  };
});
bubbleLook.hostAt = bubbleLook.styleText.indexOf(":host { all: initial; }");
// The body's light rim survives the overlay's own shadow; every focus ring is in the ink
// colour (mint on cream is below the 3:1 floor); the slide-in respects reduced motion.
await repoTab.waitForTimeout(400); // the goal box takes focus 300 ms after drawing
const ringLook = await tuck.evaluate((host) => {
  const shadow = host.shadowRoot;
  const input = shadow.querySelector("input[name=goal]");
  const rings = [...shadow.querySelector("style").sheet.cssRules]
    .filter((r) => r.selectorText?.includes(":focus-visible"))
    .map((r) => r.cssText);
  return {
    filter: getComputedStyle(shadow.querySelector("svg.tuck")).filter,
    inputFocused: shadow.activeElement === input,
    inputRing: getComputedStyle(input).outlineColor,
    ink: getComputedStyle(input).color,
    rings,
  };
});
await repoTab.emulateMedia({ reducedMotion: "reduce" });
ringLook.reducedSlide = await tuck.locator(".dock").evaluate((d) => getComputedStyle(d).transitionDuration);
// Motion (Settings → Tuck's look): with the computer's reduce motion on, "Always animate"
// still plays the strips; following the computer holds one frame.
const stripX = () => tuck.locator("svg.tuck image.tuck__strip").getAttribute("x");
const framesSeen = async (setting) => {
  await settingsPage.evaluate((m) => chrome.storage.local.set({ tuckMotion: m }), setting);
  await repoTab.waitForTimeout(200);
  const xs = new Set();
  for (let i = 0; i < 8; i++) xs.add(await stripX(), await repoTab.waitForTimeout(110));
  return xs.size;
};
const motion = { always: await framesSeen("on"), follow: await framesSeen("system") };
await repoTab.emulateMedia({ reducedMotion: "no-preference" });
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
// No goal yet: Tuck greets on every new page with the goal form. Closed without a goal,
// it stays on the next page quietly, without the form.
const noGoal = {};
const notesTab = await ctx.newPage();
await notesTab.goto(`http://localhost:${port}/notes`);
const notesForm = notesTab.locator("#tuck-companion .bubble input[name=goal]");
noGoal.formOnNewTab = await notesForm.waitFor({ timeout: 8000 }).then(
  () => 1,
  () => 0,
);
await notesTab.locator("#tuck-companion .bubble .close").click();
const recipesTab = await ctx.newPage();
await recipesTab.goto(`http://localhost:${port}/recipes`);
await recipesTab.locator("#tuck-companion .dock.in").waitFor({ timeout: 8000 });
await recipesTab.waitForTimeout(500);
noGoal.formAfterClosing = await recipesTab.locator("#tuck-companion .bubble input[name=goal]").count();
await notesTab.close();
await recipesTab.close();
await repoTab.bringToFront();
await tuck.locator("input[name=goal]").waitFor({ timeout: 8000 });
await tuck.locator("input[name=goal]").fill("Fix the checkout bug");
await tuck.locator("button.start").click();
// The goal chat with no notes yet: the person's words are the goal, nothing is looked up,
// and Tuck's own reply asks what comes first. The first step answered in the chat becomes
// a step (chatStep, from their words), and Start this makes it the goal's.
await tuck.locator(".bubble .text", { hasText: "What will you do first?" }).waitFor({ timeout: 8000 });
const goalChatTrails = await tuck.locator(".bubble .c-trail").count();
await tuck.locator("input[name=say]").fill("Write the failing checkout test");
await tuck.locator("button.start").click();
await tuck.locator(".bubble button", { hasText: "Start this" }).click({ timeout: 8000 });
// Tuck stays, resting; a click is a hello with the goal card.
await repoTab.waitForTimeout(2500);
const restState = await tuck.locator("svg.tuck").getAttribute("data-pose");
await tuck.locator(".avatar").click();
await tuck.locator(".bubble .goalcard", { hasText: "Fix the checkout bug" }).waitFor();
const clickState = await tuck.locator("svg.tuck").getAttribute("data-pose");
await tuck.locator(".avatar").click(); // a second click closes the row
await repoTab.waitForTimeout(1500);

// A reload keeps the tab and URL but wipes what was injected: Tuck comes back, resting,
// without a new greeting or the goal form (issue #22).
await repoTab.reload();
await tuck.waitFor({ state: "attached", timeout: 10000 });
const afterReload = {
  state: await tuck.locator("svg.tuck").getAttribute("data-pose"),
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
// Tuck's pose on a page (spec pose table), and waiting for one: the last pose seen.
const poseOf = (page) => page.locator("#tuck-companion svg.tuck").getAttribute("data-pose", { timeout: 2000 });
async function waitForPose(page, pose, poke = false) {
  let seen = null;
  for (let i = 0; i < 40 && seen !== pose; i++) {
    if (i) await page.waitForTimeout(250);
    if (poke) await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
    seen = await poseOf(page).catch(() => null);
  }
  return seen;
}
// Stops the extension's service worker the way Chrome stops an idle one (its Stop button in
// chrome://serviceworker-internals; Playwright has no call for it). A mark set in the worker
// through the test's handle tells that the worker came back fresh.
async function stopWorker() {
  await worker.evaluate(() => (globalThis.__beforeStop = true));
  const internals = await ctx.newPage();
  await internals.goto("chrome://serviceworker-internals/");
  const registration = internals.locator(".serviceworker-registration", { hasText: ext });
  await registration.getByRole("button", { name: "Stop" }).first().click();
  let stopped = false;
  for (let i = 0; i < 40 && !stopped; i++) {
    stopped = /Running Status: STOPPED/.test(await registration.innerText());
    if (!stopped) await internals.waitForTimeout(100);
  }
  await internals.close();
  return stopped;
}
const workerIsFresh = () => worker.evaluate(() => globalThis.__beforeStop === undefined);

// Browse: the repo, then the video. The model judges each page once. On the repo, a
// review is typed far down the page, the caret put mid-text (#60). The page grows its
// fields here: a page that loads with them shows no greeting (seen on main, 2026-11-04).
const longRepo = () =>
  repoTab.evaluate(() =>
    document.body.insertAdjacentHTML(
      "beforeend",
      `<input id="pin" type="password"><p style="height:3000px"></p><textarea id="review"></textarea><p style="height:3000px"></p>`,
    ),
  );
await repoTab.bringToFront();
await repoTab.waitForTimeout(1500);
await longRepo();
await repoTab.locator("#review").type("looks good");
await repoTab.locator("#review").evaluate((t) => t.setSelectionRange(5, 5));
await repoTab.keyboard.press("Shift");
await repoTab.evaluate(() => (document.activeElement.blur(), scrollTo(0, 0)));
const videoTab = await ctx.newPage();
await videoTab.goto(video);
await videoTab.bringToFront();
const drift1 = await waitForNewDrift(null);
const badge = await popup.evaluate(() => chrome.action.getBadgeText({}));
// Tuck on the video speaks at the first detection (L1), in the drift pose, with the
// message. Still drifting, the L2 word comes, in the drift pose too. Both say the same
// drafted line, so the L2 bubble is known by its text being drawn anew.
const onVideo = videoTab.locator("#tuck-companion");
await onVideo.locator(".bubble button[data-choice=back]").waitFor({ timeout: 2500 });
const firstState = await onVideo.locator("svg.tuck").getAttribute("data-pose");
const firstText = await onVideo.locator(".bubble .text").textContent();
const firstLine = await onVideo.locator(".bubble .text").elementHandle();
let secondWord = false;
for (let i = 0; i < 60 && !secondWord; i++) {
  const t = await lastTrigger();
  secondWord = t?.id !== drift1.id && t?.level >= 2 && !(await firstLine.evaluate((e) => e.isConnected));
  if (!secondWord) await videoTab.waitForTimeout(250);
}
const nudgeState = await onVideo.locator("svg.tuck").getAttribute("data-pose");
const videoAvatar = await onVideo.locator(".avatar").boundingBox();
const cardText = await onVideo.locator(".bubble .text").textContent();
if (shots) await videoTab.screenshot({ path: path.join(shots, "tuck-nudge.png") });
// Choosing another look in settings changes Tuck on the page in place: the open word and its
// buttons stay; the toolbar icon follows the skin.
await settingsPage.bringToFront();
await settingsPage.reload();
await worker.evaluate(() => {
  globalThis.__icons = [];
  const set = chrome.action.setIcon.bind(chrome.action);
  chrome.action.setIcon = (details) => (globalThis.__icons.push(details), set(details));
});
// The skins are listed before their change handler is set (options.js): wait for it.
await settingsPage.waitForFunction(() => document.getElementById("tuck-skin").onchange);
await settingsPage.selectOption("#tuck-skin", "paper");
const backButton = onVideo.locator(".bubble button[data-choice=back]");
await onVideo.locator("svg.tuck[data-state]").waitFor({ timeout: 5000 });
const paperKeepsBubble = await backButton.isVisible();
// A word drawn with assets read before the look change (it was on its way) keeps paper:
// the race CI hit on main (2026-11-04), sent here on purpose.
await worker.evaluate(async () => {
  const [tab] = (await chrome.tabs.query({})).filter((t) => /\/video/.test(t.url ?? ""));
  const read = (file) => fetch(chrome.runtime.getURL(`tuck/skins/kitten/${file}`)).then((r) => r.text());
  const manifest = JSON.parse(await read("skin.json"));
  const svg = globalThis.tuckSkins.spriteSvg(manifest, (n) =>
    chrome.runtime.getURL(`tuck/skins/kitten/frames/${n}.png`),
  );
  const stale = { manifest, svg, css: "", item: "none", motion: "system", readAt: Date.now() - 60000 };
  await chrome.tabs.sendMessage(tab.id, {
    type: "tuck-show",
    view: { pose: "rest", bubble: null, quiet: true },
    assets: stale,
  });
});
await videoTab.waitForTimeout(300);
const paperAfterStaleWord = await onVideo.locator("svg.tuck[data-state]").count();
const paperIcon = await worker.evaluate(() => globalThis.__icons.at(-1)?.path?.[16]);
await settingsPage.selectOption("#tuck-skin", "v1");
await onVideo.locator("svg.tuck:not([data-state])").waitFor({ timeout: 5000 });
await settingsPage.selectOption("#tuck-item", "frisbee");
await onVideo.locator("svg.tuck[data-item=frisbee]").waitFor({ timeout: 5000 });
const frisbeeKeepsBubble = await backButton.isVisible();
await settingsPage.selectOption("#tuck-item", "bandana");
await onVideo.locator("svg.tuck[data-item=bandana]").waitFor({ timeout: 5000 });
// A skin the popup does not know falls back to the default, as the background does.
await settingsPage.evaluate(() => chrome.storage.local.set({ tuckSkin: "gone" }));
await popup.reload();
// The popup draws its mark after its module's top-level await, so after the load event.
await popup
  .locator("#tuck-mark svg.tuck")
  .waitFor({ timeout: 5000 })
  .catch(() => {});
const popupFallback = await popup.locator("#tuck-mark svg.tuck").count();
await settingsPage.evaluate(() => chrome.storage.local.set({ tuckSkin: "kitten" }));
await videoTab.bringToFront();
await onVideo.locator(".bubble button[data-choice=back]").click();
const spotRing = await repoTab
  .locator("#tuck-spot")
  .waitFor({ timeout: 3000 })
  .then(() => true)
  .catch(() => false);
const backAtSpot = await repoTab.evaluate(() => {
  const t = document.getElementById("review");
  const r = t.getBoundingClientRect();
  return {
    inView: r.top >= 0 && r.bottom <= innerHeight,
    focused: document.activeElement === t,
    caret: t.selectionStart,
  };
});
await popup.waitForTimeout(800);
if (shots) await popup.screenshot({ path: path.join(shots, "popup-trigger.png"), fullPage: true });
const backTo = await activeUrl();
await repoTab.waitForTimeout(1700);
const spotRingGone = (await repoTab.locator("#tuck-spot").count()) === 0;

// #60: on a never-read site nothing is restored: the tab comes to the front as before.
const reading = await settingsPage.evaluate(async () => (await chrome.storage.local.get("pageReading")).pageReading);
await settingsPage.evaluate(() => chrome.storage.local.set({ pageReading: { neverRead: ["127.0.0.1"] } }));
await repoTab.bringToFront();
await repoTab.waitForTimeout(500);
await repoTab.evaluate(() => (document.activeElement.blur(), scrollTo(0, 0)));
await videoTab.bringToFront();
const driftNever = await waitForNewDrift(drift1.id);
await clickOnCard("#take-me-back");
const backNever = await repoTab.evaluate(() => ({ y: scrollY, focus: document.activeElement.tagName }));
await settingsPage.evaluate((r) => chrome.storage.local.set({ pageReading: r ?? {} }), reading);

// #60: after a reload the field is gone; the scroll position comes back. Typing in a
// password field keeps nothing, and it is never focused. The reloaded page is short, so
// Chrome's own scroll restoring cannot reach 1200; it grows again at the top.
await repoTab.bringToFront();
await repoTab.waitForTimeout(500);
await repoTab.evaluate(() => scrollTo(0, 1200));
await repoTab.waitForTimeout(500);
await repoTab.reload();
await repoTab.waitForTimeout(1500);
await longRepo();
await repoTab.locator("#pin").type("1234");
await repoTab.evaluate(() => document.activeElement.blur());
const reloadedAt = await repoTab.evaluate(() => scrollY);
await videoTab.bringToFront();
const driftReload = await waitForNewDrift(driftNever.id);
await clickOnCard("#take-me-back");
const backReload = await repoTab.evaluate(() => ({ y: scrollY, focus: document.activeElement.id }));

// The related tab is gone: "Take me back" reopens its page.
await videoTab.bringToFront();
const drift2 = await waitForNewDrift(driftReload.id);
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

// Issue #38: the same, with the page too slow to say where the person works. The chat it
// reads says nothing about the feed under it: scrolling the feed still drifts.
await settingsPage.evaluate(async () => {
  const { attentionConfig } = await chrome.storage.local.get("attentionConfig");
  await chrome.storage.local.set({ attentionConfig: { ...attentionConfig, regionWaitMs: 0 } });
});
await workTab.bringToFront();
await workTab.waitForTimeout(2500);
const slowTab = await ctx.newPage();
await slowTab.goto(dockFeedSlow);
await slowTab.bringToFront();
await slowTab.locator("#tuck-companion").waitFor({ state: "attached" });
await slowTab.click("#slow-box");
await slowTab.waitForTimeout(6000);
const afterSlowChat = await lastTrigger();
await slowTab.mouse.move(100, 300);
await slowTab.mouse.wheel(0, 100);
const driftSlowFeed = await waitForNewDrift(afterSlowChat.id);
await slowTab.close();
await workTab.close();
await settingsPage.evaluate(async () => {
  const { attentionConfig } = await chrome.storage.local.get("attentionConfig");
  delete attentionConfig.regionWaitMs;
  await chrome.storage.local.set({ attentionConfig });
});

// Review: reading turned off. The chat's earlier "work" verdict no longer counts, and
// nothing is read: the chat page is a drift again.
await settingsPage.evaluate(() => chrome.storage.local.set({ pageReading: { enabled: false } }));
await chatTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
const driftOff = await waitForNewDrift(driftSlowFeed.id);

// A coding agent's status, as the bridge sends it (#11).
const agentSays = (status) =>
  popup.evaluate((s) => chrome.runtime.sendMessage({ type: "agent-status", status: s, session: "s1" }), status);

// A break from the nudge: Tuck stays on the page, asleep, for the whole break (spec pose
// table). Review Focus 1: the service worker stops during the break; a page opened then is
// drawn from the state kept in storage, still asleep. The break ends on a work page with
// nothing to say, and Tuck wakes there quietly. While the agent works, the page in front
// shows Tuck working, also on a fresh page after another stop.
await settingsPage.evaluate(async () => {
  const { attentionConfig } = await chrome.storage.local.get("attentionConfig");
  await chrome.storage.local.set({ attentionConfig: { ...attentionConfig, breakMin: 0.25 } }); // 15 s
});
await chatTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
const breakButton = chatTab.locator("#tuck-companion .bubble button[data-choice=break]");
await breakButton.waitFor({ timeout: 15000 });
const breakFrom = await lastTrigger();
await breakButton.click();
const onBreak = {
  pose: await waitForPose(chatTab, "sleep"),
  bubble: await chatTab.locator("#tuck-companion .bubble").isVisible(),
  shown: await chatTab.locator("#tuck-companion .dock.in").count(),
};
const stoppedOnBreak = await stopWorker();
const breakPage = await ctx.newPage();
await breakPage.goto(compose); // not the video: its judgments are counted below
await breakPage.bringToFront();
await breakPage.locator("#tuck-companion").waitFor({ state: "attached", timeout: 10000 });
const afterStopOnBreak = {
  pose: await waitForPose(breakPage, "sleep"),
  bubble: await breakPage.locator("#tuck-companion .bubble").isVisible(),
  fresh: await workerIsFresh(),
};
// The goal card on a break: Tuck says hello, and goes back to sleep when it closes.
await breakPage.locator("#tuck-companion .avatar").click();
await breakPage.locator("#tuck-companion .bubble .goalcard", { hasText: "Fix the checkout bug" }).waitFor();
const cardOnBreak = await poseOf(breakPage);
await breakPage.locator("#tuck-companion .avatar").click(); // a second click closes the row
const afterCardOnBreak = await waitForPose(breakPage, "sleep");
await breakPage.close();
const wakeTab = await ctx.newPage();
await wakeTab.goto(repo);
await wakeTab.bringToFront();
await wakeTab.locator("#tuck-companion").waitFor({ state: "attached", timeout: 10000 });
const asleepAtWork = await waitForPose(wakeTab, "sleep");
// Until the break runs out, then a look at the page in front.
const { breakUntil } = (await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }))).engine;
await wakeTab.waitForTimeout(Math.max(0, breakUntil - Date.now()) + 250);
const wokePose = await waitForPose(wakeTab, "rest", true);
const afterBreak = {
  bubble: await wakeTab.locator("#tuck-companion .bubble").isVisible(),
  trigger: (await lastTrigger())?.kind,
  state: (await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }))).engine.state,
};
await agentSays("working");
const agentWorkPose = await waitForPose(wakeTab, "work");
const agentWorkBubble = await wakeTab.locator("#tuck-companion .bubble").isVisible();
const stoppedWhileWorking = await stopWorker();
const workPage = await ctx.newPage();
await workPage.goto(repo);
await workPage.bringToFront();
await workPage.locator("#tuck-companion").waitFor({ state: "attached", timeout: 10000 });
const afterStopWorking = { pose: await waitForPose(workPage, "work"), fresh: await workerIsFresh() };
await agentSays("unknown");
const afterAgentStops = await waitForPose(workPage, "rest");
await workPage.close();
await wakeTab.close();
await settingsPage.evaluate(async () => {
  const { attentionConfig } = await chrome.storage.local.get("attentionConfig");
  delete attentionConfig.breakMin;
  await chrome.storage.local.set({ attentionConfig });
});
await chatTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));

// Whose turn it is in a coding agent (#11): while it works the same drifting page is a
// wait; when it stops Tuck says so, once.
const agentTab = await ctx.newPage();
await agentTab.goto(dockedSocial);
await agentTab.bringToFront();
await agentSays("working");
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await agentTab.waitForTimeout(500);
const beforeWait = await lastTrigger();
await agentTab.waitForTimeout(6000);
const duringWait = await lastTrigger();
const workPose = await waitForPose(agentTab, "work");
const workBubble = await agentTab.locator("#tuck-companion .bubble").isVisible();
const waitStatus = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }));
const waitBadge = await popup.evaluate(() => chrome.action.getBadgeText({}));
await agentSays("waiting_for_user");
await agentSays("waiting_for_user");
await agentTab.locator("#tuck-companion").waitFor({ state: "attached" });
await agentTab.waitForTimeout(500);
const agentWord = await lastTrigger();
const agentBubble = await agentTab.locator("#tuck-companion .bubble").innerText();
const waitPose = await poseOf(agentTab);
// The popup answers an agent's word as the bubble does: nothing teaches about the page.
await popup.reload();
await popup.waitForSelector("#trigger:not([hidden])");
const agentPopup = {
  gotIt: await popup.isVisible("#got-it"),
  back: await popup.isVisible("#take-me-back"),
  forTask: await popup.isVisible("#for-my-task"),
};
// Still waiting: Tuck asks again, on the page in front, with no new status from the agent.
// Its line is the model's, written when the first wait was said (#67).
await agentTab.bringToFront();
await agentTab
  .locator("#tuck-companion .bubble", { hasText: "Muse may still need you. Want to check?" })
  .waitFor({ timeout: 10000 });
await agentTab.close();
await agentSays("unknown");

// Muse back at work: the person answered it in the terminal, so the word about the wait
// comes down, on a work page too, where no change of state would take it down (#66).
const resumeTab = await ctx.newPage();
await resumeTab.goto(repo);
await resumeTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await agentSays("working");
await agentSays("waiting_for_user");
const waitBubble = resumeTab.locator("#tuck-companion .bubble", { hasText: "Muse is waiting on you." });
await waitBubble.waitFor({ timeout: 8000 });
await agentSays("working");
const waitGone = await resumeTab
  .locator("#tuck-companion .bubble")
  .waitFor({ state: "hidden", timeout: 3000 })
  .then(
    () => true,
    () => false,
  );
const resumedWord = await lastTrigger();
const resumedBadge = await popup.evaluate(() => chrome.action.getBadgeText({}));
await resumeTab.close();
await agentSays("unknown");

// A stop on a page Tuck cannot draw on is said on the next page it can.
const noDrawTab = await ctx.newPage();
await noDrawTab.goto("chrome://version");
await noDrawTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await agentSays("working");
// The bridge holds a turn's end and says so at once: Tuck writes the word meanwhile (#67).
await popup.evaluate(() =>
  chrome.runtime.sendMessage({ type: "agent-status", status: "completed", session: "s1", preview: true }),
);
await noDrawTab.waitForTimeout(500);
await agentSays("completed");
await noDrawTab.waitForTimeout(500);
const drawTab = await ctx.newPage();
await drawTab.goto(dockedSocial);
await drawTab.bringToFront();
await drawTab.locator("#tuck-companion .bubble").waitFor({ timeout: 8000 });
const heldBubble = await drawTab.locator("#tuck-companion .bubble").innerText();
await drawTab.close();
await noDrawTab.close();

// Off stops Tuck speaking, not the record of whose turn it is.
const setMode = (mode) => popup.evaluate((m) => chrome.runtime.sendMessage({ type: "set-mode", mode: m }), mode);
await agentSays("working");
await setMode("off");
await agentSays("completed");
await setMode("focus");
const afterOff = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }));
await agentSays("unknown");
await chatTab.bringToFront();

// Tuck away (spec "Tuck away"): one click on the card hides Tuck; it then comes only for a drift
// or an agent word, and leaves again after the answer. The popup's Bring Tuck back brings it
// back, and so does the day's session start.
const tuckAwayNow = () => popup.evaluate(async () => (await chrome.storage.local.get("tuckAway")).tuckAway === true);
const dockCount = (page) => page.locator("#tuck-companion .dock.in").count();
async function settledDockCount(page, wait = 1500) {
  await page.waitForTimeout(wait);
  return dockCount(page);
}
// #87: Tuck away takes its turn with the words being drawn. A word already on its way (its
// job past the away check, held here at Chrome's executeScript, a fake at the boundary) is
// drawn and then hidden, not drawn after the hide.
await worker.evaluate(() => {
  const run = chrome.scripting.executeScript.bind(chrome.scripting);
  globalThis.__runScript = run;
  globalThis.__held = new Promise((r) => (globalThis.__release = r));
  globalThis.__holding = false;
  chrome.scripting.executeScript = async (details) => {
    const tab = await chrome.tabs.get(details.target.tabId).catch(() => null);
    if (!globalThis.__holding && /\/notes$/.test(tab?.url ?? "")) {
      globalThis.__holding = true;
      await globalThis.__held;
    }
    return run(details);
  };
});
const raceTab = await ctx.newPage();
await raceTab.goto(`http://localhost:${port}/notes`);
await raceTab.bringToFront();
// Not waited for: its reply comes once the held word is drawn.
await popup.evaluate(() => void chrome.runtime.sendMessage({ type: "record-active" }));
const awayRace = { held: false };
for (let i = 0; i < 50 && !awayRace.held; i++) {
  if (i) await raceTab.waitForTimeout(100);
  awayRace.held = await worker.evaluate(() => globalThis.__holding);
}
// The popup's Tuck away meanwhile: its reply, or a second without one (it waits its turn).
await popup.evaluate(() =>
  Promise.race([chrome.runtime.sendMessage({ type: "tuck-away" }), new Promise((r) => setTimeout(r, 1000))]),
);
await worker.evaluate(() => {
  chrome.scripting.executeScript = globalThis.__runScript;
  globalThis.__release();
});
awayRace.drawn = await settledDockCount(raceTab, 1500);
awayRace.flag = await tuckAwayNow();
await raceTab.close();
await popup.evaluate(() => chrome.storage.local.set({ tuckAway: false }));
// An older tab with Tuck drawn on it, from before Tuck was tucked away.
const awayOlder = await ctx.newPage();
await awayOlder.goto(repo);
await awayOlder.bringToFront();
await awayOlder.locator("#tuck-companion .dock.in").waitFor({ timeout: 10000 });
await awayOlder.evaluate(() => (document.title = "Tuck away: older tab"));
// #87: a tab in another window, with Tuck drawn on it. Closed after each check, with focus
// back where it was: headless Chromium keeps the newest window the last focused, whichever
// tab comes to the front, and opens new pages in it.
async function otherWindow() {
  const back = await popup.evaluate(async () => (await chrome.windows.getLastFocused()).id);
  const [page] = await Promise.all([
    ctx.waitForEvent("page"),
    popup.evaluate((url) => chrome.windows.create({ url }), repo),
  ]);
  await page.waitForLoadState();
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
  await page.locator("#tuck-companion .dock.in").waitFor({ timeout: 10000 });
  return { page, back };
}
async function closeOtherWindow({ page, back }) {
  await page.close();
  await popup.evaluate((id) => chrome.windows.update(id, { focused: true }), back);
}
const awayTab = await ctx.newPage();
await awayTab.goto(repo);
await awayTab.bringToFront();
await awayTab.locator("#tuck-companion .dock.in").waitFor({ timeout: 10000 });
let awayWindow = await otherWindow();
await awayTab.locator("#tuck-companion .avatar").click();
const tuckAwayButton = awayTab.locator("#tuck-companion .bubble button", { hasText: "Tuck away" });
await tuckAwayButton.waitFor({ timeout: 5000 });
await tuckAwayButton.click();
const away = { flag: undefined, here: undefined, next: undefined };
// Tuck says how to come back, then leaves.
away.parting = await awayTab
  .locator("#tuck-companion .dock.in .bubble:not([hidden]) .text", { hasText: "bring me back" })
  .textContent({ timeout: 3000 })
  .catch(() => null);
await awayTab
  .locator("#tuck-companion .dock.in")
  .waitFor({ state: "detached", timeout: 5000 })
  .catch(() => {});
away.here = await settledDockCount(awayTab, 800);
away.flag = await tuckAwayNow();
// The toolbar icon says so (#87): "zz" and a tooltip.
away.mark = await popup.evaluate(async () => ({
  badge: await chrome.action.getBadgeText({}),
  title: (await chrome.action.getTitle({})).includes("tucked away"),
}));
away.otherWindow = await dockCount(awayWindow.page);
await closeOtherWindow(awayWindow);
// Every tab lets Tuck go, not just the one clicked: the older tab shows no Tuck in front.
await awayOlder.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
away.olderTab = await settledDockCount(awayOlder, 800);
// A Tuck left on a tab (drawn there while away, then another tab took the word) goes when
// that tab comes to the front again.
await awayTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ title: "Tuck away: older tab" });
  const read = async (f) => (await fetch(chrome.runtime.getURL(`tuck/skins/v1/${f}`))).text();
  const assets = {
    manifest: JSON.parse(await read("skin.json")),
    svg: await read("tuck.svg"),
    css: await read("tuck.css"),
    item: "none",
  };
  await chrome.tabs.sendMessage(tab.id, { type: "tuck-show", view: { pose: "rest", bubble: null }, assets });
});
away.staleDrawn = await settledDockCount(awayOlder, 500);
await awayOlder.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
away.staleOnSwitch = await settledDockCount(awayOlder, 800);
// A click on a Tuck still on the page while away sends it away, not to the goal card.
await worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ title: "Tuck away: older tab" });
  const read = async (f) => (await fetch(chrome.runtime.getURL(`tuck/skins/v1/${f}`))).text();
  const assets = {
    manifest: JSON.parse(await read("skin.json")),
    svg: await read("tuck.svg"),
    css: await read("tuck.css"),
    item: "none",
  };
  await chrome.tabs.sendMessage(tab.id, { type: "tuck-show", view: { pose: "rest", bubble: null }, assets });
});
await awayOlder.locator("#tuck-companion .dock.in").waitFor({ timeout: 3000 });
await awayOlder.locator("#tuck-companion .avatar").click();
away.clickWhileAway = await settledDockCount(awayOlder, 1000);
away.cardWhileAway = await awayOlder.locator("#tuck-companion .bubble:not([hidden])").count();
const awayNext = await ctx.newPage();
await awayNext.goto(repo);
await awayNext.bringToFront();
away.next = await settledDockCount(awayNext);
// A drift still comes, with its bubble, and the answer sends Tuck away again.
const beforeAwayDrift = await lastTrigger();
const awayDriftTab = await ctx.newPage();
await awayDriftTab.goto(dockedSocial);
await awayDriftTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await waitForNewDrift(beforeAwayDrift?.id ?? null);
await awayDriftTab.locator("#tuck-companion .bubble button[data-choice=back]").waitFor({ timeout: 8000 });
away.driftPose = await poseOf(awayDriftTab);
await awayDriftTab.locator("#tuck-companion .bubble button[data-choice=back]").click();
away.afterDrift = await settledDockCount(awayDriftTab, 2500);
await awayDriftTab.close();
// Clicking Tuck with the drift word open answers it as × does: Tuck leaves with it.
const beforeAvatarDrift = await lastTrigger();
const awayAvatarTab = await ctx.newPage();
await awayAvatarTab.goto(dockedSocial);
await awayAvatarTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await waitForNewDrift(beforeAvatarDrift?.id ?? null);
await awayAvatarTab.locator("#tuck-companion .bubble button[data-choice=back]").waitFor({ timeout: 8000 });
await awayAvatarTab.locator("#tuck-companion .avatar").click();
away.afterAvatarClick = await settledDockCount(awayAvatarTab, 1500);
away.avatarAnswer = (await lastTrigger())?.choice;
await awayAvatarTab.close();
// #87: × on the drift word, a break from it, and "This is for my task": Tuck leaves each
// time, and stays away through the break and its end.
async function awayDrift(answer) {
  const before = await lastTrigger();
  const tab = await ctx.newPage();
  await tab.goto(dockedSocial);
  await tab.bringToFront();
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
  await waitForNewDrift(before?.id ?? null);
  const button = tab.locator(`#tuck-companion .bubble ${answer}`);
  await button.waitFor({ timeout: 15000 });
  await button.click();
  return tab;
}
const awayCloseTab = await awayDrift(".close");
away.afterClose = await settledDockCount(awayCloseTab, 1500);
away.closeAnswer = (await lastTrigger())?.choice;
await awayCloseTab.close();
await settingsPage.evaluate(async () => {
  const { attentionConfig } = await chrome.storage.local.get("attentionConfig");
  await chrome.storage.local.set({ attentionConfig: { ...attentionConfig, breakMin: 0.25 } }); // 15 s
});
const awayBreakTab = await awayDrift("button[data-choice=break]");
away.afterBreakAnswer = await settledDockCount(awayBreakTab, 1500);
await awayBreakTab.close();
const awayOnBreak = await ctx.newPage();
await awayOnBreak.goto(repo);
await awayOnBreak.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
away.onBreakPage = await settledDockCount(awayOnBreak);
const awayBreak = (await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }))).engine;
away.breakState = awayBreak.state;
await awayOnBreak.waitForTimeout(Math.max(0, awayBreak.breakUntil - Date.now()) + 250);
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
away.afterBreakEnds = await settledDockCount(awayOnBreak);
away.breakOver =
  (await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }))).engine.state !== "break";
await awayOnBreak.close();
await settingsPage.evaluate(async () => {
  const { attentionConfig } = await chrome.storage.local.get("attentionConfig");
  delete attentionConfig.breakMin;
  await chrome.storage.local.set({ attentionConfig });
});
const awayRelatedTab = await awayDrift("button[data-choice=related]");
away.afterRelated = await settledDockCount(awayRelatedTab, 1500);
await awayRelatedTab.close();
// An agent's word comes, and Got it sends Tuck away again.
await awayNext.bringToFront();
await agentSays("working");
await agentSays("waiting_for_user");
await awayNext.locator("#tuck-companion .bubble button[data-choice=dismiss]").waitFor({ timeout: 8000 });
away.agentPose = await poseOf(awayNext);
await awayNext.locator("#tuck-companion .bubble button[data-choice=dismiss]").click();
away.afterAgent = await settledDockCount(awayNext, 1500);
await agentSays("unknown");
// Review Focus 5: the word met a page Tuck cannot draw on; it comes once, on the next page that can.
const awayNoDraw = await ctx.newPage();
await awayNoDraw.goto("chrome://version");
await awayNoDraw.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await agentSays("working");
await agentSays("waiting_for_user");
await awayNoDraw.waitForTimeout(500);
const awayHeld = await ctx.newPage();
await awayHeld.goto(repo);
await awayHeld.bringToFront();
await awayHeld.locator("#tuck-companion .bubble button[data-choice=dismiss]").waitFor({ timeout: 8000 });
away.heldCount = await awayHeld.locator("#tuck-companion .bubble").count();
await awayHeld.locator("#tuck-companion .bubble button[data-choice=dismiss]").click();
away.afterHeld = await settledDockCount(awayHeld, 1500);
await agentSays("unknown");
const awayLater = await ctx.newPage();
await awayLater.goto(repo);
await awayLater.bringToFront();
away.later = await settledDockCount(awayLater);
// The popup's card is the way back. In front: a page Tuck was drawn on and left (a page
// that never had Tuck gets it from any look at it, as after a reload).
await awayHeld.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await awayHeld.waitForTimeout(500);
await popup.reload();
await popup.locator("#bring-back").waitFor({ timeout: 5000 });
away.popupWhileAway = {
  card: await popup.isVisible("#away-card"),
  text: await popup.locator("#away-card span").textContent(),
  awayButton: await popup.isVisible("#tuck-away"),
};
await popup.click("#bring-back");
await popup.waitForTimeout(300);
away.flagAfterSwitch = await tuckAwayNow();
away.markAfterBack = await popup.evaluate(async () => ({
  badge: await chrome.action.getBadgeText({}),
  title: (await chrome.action.getTitle({})).includes("tucked away"),
}));
// Tuck is back at once on the page in front, without a page change.
away.backInPlace = await awayHeld
  .locator("#tuck-companion .dock.in")
  .waitFor({ timeout: 5000 })
  .then(() => 1)
  .catch(() => 0);
away.popupAfterBack = { card: await popup.isVisible("#away-card"), awayButton: await popup.isVisible("#tuck-away") };
// The popup's Tuck away hides Tuck on the page in front, and in the other window (#87).
awayWindow = await otherWindow();
await popup.click("#tuck-away");
await popup.waitForTimeout(300);
away.popupAwayFlag = await tuckAwayNow();
away.afterPopupAway = await settledDockCount(awayHeld, 800);
away.afterPopupAwayOtherWindow = await dockCount(awayWindow.page);
await closeOtherWindow(awayWindow);
// Bring Tuck back again for what follows, from a new tab, where Tuck cannot be drawn: it
// comes on the next page (#87).
const awayNewTab = await ctx.newPage();
await awayNewTab.goto("chrome://newtab");
await awayNewTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await popup.click("#bring-back");
await popup.waitForTimeout(300);
away.flagBackOnNewTab = await tuckAwayNow();
await awayHeld.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
away.backAfterNewTab = await awayHeld
  .locator("#tuck-companion .dock.in")
  .waitFor({ timeout: 5000 })
  .then(() => 1)
  .catch(() => 0);
await awayNewTab.close();
const awayBack = await ctx.newPage();
await awayBack.goto(repo);
await awayBack.bringToFront();
await awayBack.locator("#tuck-companion .dock.in").waitFor({ timeout: 10000 });
away.restingAgain = await poseOf(awayBack);
// A new day's session start clears it.
await awayBack.locator("#tuck-companion .avatar").click();
await awayBack.locator("#tuck-companion .bubble button", { hasText: "Tuck away" }).click();
await awayBack.waitForTimeout(500);
away.hiddenAgain = await tuckAwayNow();
await awayBack
  .locator("#tuck-companion .dock.in")
  .waitFor({ state: "detached", timeout: 5000 })
  .catch(() => {});
// #87: still away after Chrome stops the idle service worker.
away.stoppedWhileAway = await stopWorker();
const awayAfterStop = await ctx.newPage();
await awayAfterStop.goto(repo);
await awayAfterStop.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
away.afterStop = await settledDockCount(awayAfterStop);
away.freshAfterStop = await workerIsFresh();
away.flagAfterStop = await tuckAwayNow();
await awayAfterStop.close();
await awayBack.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
// Done on a goal of its own, so the checkout goal is replaced, not finished (the day
// summary below says so).
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "set-intent", title: "Try Tuck away" }));
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "complete-intent" }));
// A look at the page with no goal (the heartbeat's): the day's greeting was had before
// the restart above, so it does not come again.
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
away.afterDoneWhileAway = await settledDockCount(awayBack, 1500);
await agentSays("working");
await popup.evaluate(() => chrome.storage.session.set({ pendingGreeting: true }));
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await awayBack.locator("#tuck-companion .bubble input[name=goal]").waitFor({ timeout: 10000 });
away.flagAfterGreeting = await tuckAwayNow();
// The goal set from Tuck's form while the agent works: once the note closes, Tuck works.
await awayBack.locator("#tuck-companion .bubble input[name=goal]").fill("Fix the checkout bug");
await awayBack.locator("#tuck-companion button.start").click();
await awayBack.locator("#tuck-companion .bubble button", { hasText: "Set as goal" }).click({ timeout: 8000 });
await awayBack.locator("#tuck-companion .bubble .text", { hasText: "Got it" }).waitFor({ timeout: 5000 });
await awayBack.locator("#tuck-companion .bubble .close").click(); // the chat stays until closed
await awayBack.waitForTimeout(2600);
away.goalSetWhileWorking = await poseOf(awayBack);
await agentSays("unknown");
// The greeting named the due to-do item (once a day); let the reminder test below hear it fresh.
await popup.evaluate(async () => {
  const { loops } = await chrome.storage.local.get("loops");
  for (const l of Object.values(loops ?? {})) delete l.saidOn;
  await chrome.storage.local.set({ loops });
});
for (const page of [awayOlder, awayTab, awayNext, awayNoDraw, awayHeld, awayLater, awayBack]) await page.close();
await chatTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));

// A page for something else on the to-do list is not drift (#8), and is no place to go back to.
const beforeTax = await lastTrigger();
const taxTab = await ctx.newPage();
await taxTab.goto(`http://localhost:${port}/tax`);
await taxTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await taxTab.waitForTimeout(6000);
const afterTax = await lastTrigger();
const taxStatus = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }));
await taxTab.close();
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
// No brain folder yet: Done stays in Tuck (#95).
const doneNotesUnconnected = await settingsPage.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  const hits = await (await Memory.open()).recall("marked done in Tuck", { limit: 50 });
  return hits.filter((h) => /marked done in Tuck/.test(h.title)).length;
});
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

// Switched on with no goal: Tuck asks for one at once (the day's greeting went by while off).
await chatTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await setMode("off");
await setMode("focus");
const switchedOnGreeting = await chatTab
  .locator("#tuck-companion .dock.in .bubble:not([hidden])", { has: chatTab.locator("input[name=goal]") })
  .locator(".text")
  .textContent({ timeout: 5000 })
  .catch(() => null);

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
// Issue #43: while the node has judged nothing, the raw queue is not shown as tasks: only
// a Markdown checkbox, with the reason for the rest. A reload still gives the reason.
tasksCut = true;
await importNotes();
await settingsPage.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  const { fromMarkdownFolder } = await import("/memory/markdown.js");
  const memory = await Memory.open();
  await memory.importEntries({
    origin: "md:Vault",
    name: "Vault",
    ...fromMarkdownFolder([{ path: "todo.md", text: "- [ ] Water the plants" }], { folderName: "Vault" }),
  });
});
await reread();
const failedRows = await settingsPage.locator("#task-list").innerText();
const failedStatus = await settingsPage.locator("#task-status").innerText();
await settingsPage.reload();
await settingsPage.waitForFunction(() => /could not read/.test(document.getElementById("task-status").textContent));
const failedStatusLater = await settingsPage.locator("#task-status").innerText();
await settingsPage.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  await (await Memory.open()).removeSource("md:Vault");
});
tasksCut = false;
await importNotes();
await reread();
const taskRows = await settingsPage.locator("#task-list .row").count();
// One note the node did not read stays off the list, next to what it did read (#43).
tasksCut = true;
await settingsPage.evaluate(
  async (files) => {
    const { Memory } = await import("/memory/index.js");
    await (await Memory.open()).importFiles(files);
  },
  [
    ...notes,
    {
      path: "notes/log/2026/fact1.md",
      text: '---\ntitle: "Rent went up"\nkind: fact\ntopic: home\ndate: 2026-11-01\nsource: test\nid: fact1\n---\n\n- **Context:** Invented.\n- **Decision/Result:** Noted.\n- **Evidence:** none\n- **Next action:** Check it\n',
    },
  ],
);
await reread();
const partialRows = await settingsPage.locator("#task-list").innerText();
const partialStatus = await settingsPage.locator("#task-status").innerText();
tasksCut = false;
await importNotes();
await reread();
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

// Issue #47: one commitment, one row. Two notes and a notes-folder checkbox about the same
// train tickets are one row that names where they came from, and Done on it takes all
// three off. Two trip tasks the model wrongly called one are split with Not the same, and
// stay apart. A re-import with nothing new asks about no pair.
const pairNotes = [
  ["lyon1", "todo", 5, "Train tickets to Lyon", "Buy the train tickets"],
  ["lyon2", "event", 3, "Lyon train tickets still to buy", "Buy them"],
  ["rome1", "todo", 4, "Rome trip: hotel", "Find a hotel"],
  ["rome2", "todo", 4, "Rome trip: flights", "Find the flights"],
].map(([id, kind, ago, title, next]) => ({
  path: `notes/log/2026/${id}.md`,
  text: [
    "---",
    `title: "${title}"`,
    `kind: ${kind}`,
    "topic: trip",
    `date: ${new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10)}`,
    "source: test",
    `id: ${id}`,
    "---",
    "",
    "- **Context:** Invented for the test.",
    "- **Decision/Result:** Noted.",
    "- **Evidence:** none",
    `- **Next action:** ${next}`,
  ].join("\n"),
}));
const importTrip = () =>
  settingsPage.evaluate(async (files) => {
    const { Memory } = await import("/memory/index.js");
    const { fromMarkdownFolder } = await import("/memory/markdown.js");
    const memory = await Memory.open();
    await memory.importFiles(files);
    const vault = fromMarkdownFolder([{ path: "todo.md", text: "- [ ] train tickets to Lyon" }], {
      folderName: "Vault",
    });
    await memory.importEntries({ origin: "md:Vault", name: "Vault", ...vault });
  }, pairNotes);
await importTrip();
await reread();
const groupedText = await settingsPage.locator("#task-list").innerText();
// The checkbox is the person's own, so the notes' Rome row sits under the fold (#92).
const allRows = "#task-list .row, #task-suggested .row";
const groupedRows = await settingsPage.locator(allRows).count();
const romeFolded = await settingsPage.locator("#task-suggested .row", { hasText: "Rome" }).count();
const askedPairs = pairCalls.length;
await settingsPage.click("#task-suggested summary");
await settingsPage
  .locator("#task-suggested .row", { hasText: "Rome" })
  .getByRole("button", { name: "Not the same" })
  .click();
await settingsPage.waitForTimeout(300);
const splitRows = await settingsPage.locator(allRows).count();
await settingsPage.locator("#task-list .row", { hasText: /Lyon/i }).getByRole("button", { name: "Done" }).click();
await settingsPage.waitForTimeout(300);
await importTrip();
await reread();
const tripTextAfter = await settingsPage.locator("#task-list").innerText();
const pairsAgain = pairCalls.length - askedPairs;
const tripLoops = await settingsPage.evaluate(async () => (await chrome.storage.local.get("loops")).loops);

// Issue #46: a goal that ran out while the browser was closed is summed up at the next
// start: one entry in memory, with no page title, and the greeting says how it went, in
// the template while the model's line is not ready, then in the model's words. The day
// is seeded into the log: a test cannot wait two hours.
const launch = await settingsPage.evaluate(async () => {
  const { openStore } = await import("/attention/store.js");
  const { makeIntent, dayKey } = await import("/attention/intents.js");
  const { relevanceKey, hostOf } = await import("/attention/relevance.js");
  const { DEFAULTS } = await import("/attention/config.js");
  const st = await openStore();
  const t0 = Date.now() - 24 * 3600 * 1000;
  const intent = makeIntent({ title: "Plan the launch" }, t0);
  await st.putIntent(intent);
  const url = "https://github.com/acme/launch";
  const title = "launch-plan.md · acme/launch";
  const events = [
    {
      type: "session",
      ts: t0,
      kind: "intent_set",
      payload: { id: intent.id, title: intent.title, topic: intent.topic },
    },
    {
      type: "context",
      ts: t0 + 1000,
      tabId: 1,
      url,
      host: hostOf(url),
      title,
      key: relevanceKey(intent.id, url, title),
      label: "related",
      confidence: 0.9,
      source: "llm",
      audible: false,
      browserFocused: true,
      idleState: "active",
      surface: { kind: "page", labels: [] },
    },
  ];
  for (let ts = t0 + 30000; ts <= t0 + 130 * 60000; ts += 30000) events.push({ type: "tick", ts });
  for (const e of events) await st.appendEvent(e);
  return { id: intent.id, date: dayKey(t0, DEFAULTS) };
});
const dayEntries = (query) =>
  settingsPage.evaluate(async (query) => {
    const { Memory } = await import("/memory/index.js");
    const hits = await (await Memory.open()).recall(query, { limit: 50 });
    return hits
      .map((h) => h.item)
      .filter((e) => e.topic === "focus" && /^Day /.test(e.title ?? "") && e.title.includes(`: ${query}: `));
  }, query);
const greetAfterRestart = async () => {
  await settingsPage.evaluate(() => chrome.storage.session.clear());
  const tab = await ctx.newPage();
  await tab.goto(repo);
  const t = tab.locator("#tuck-companion");
  await greetingShown(t);
  const said = await t.locator(".bubble .text").textContent();
  await tab.close();
  return said;
};
const morning = await greetAfterRestart();
const launchEntries = await dayEntries("Plan the launch");
await settingsPage.evaluate(async (id) => {
  for (let i = 0; i < 100; i++) {
    const { greetingLine } = await chrome.storage.local.get("greetingLine");
    if (greetingLine?.intentId === id) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the greeting's line never came");
}, launch.id);
const nextMorning = await greetAfterRestart();
const launchEntriesLater = await dayEntries("Plan the launch");
const checkoutEntries = await dayEntries("Fix the checkout bug");

// #81, #78: setting a goal starts the agent. It reads the person's notes and makes a plan;
// its first step becomes the goal's step, so the next drift word is written with it.
// "I'm stuck" gets one step, and Settings lists the tools the agent called.
await settingsPage.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  await (
    await Memory.open()
  ).add({
    kind: "fact",
    topic: "demo",
    title: "Demo video rules",
    context: "The hackathon wants a demo video.",
    result: "The demo video is at most 3 minutes. Never show the API key on screen.",
    next: "none",
  });
  await chrome.runtime.sendMessage({ type: "memory-changed" });
});
// A slow model first: neither setting the goal nor finishing it waits for the loop.
loopSlowMs = 8000;
const slowStart = Date.now();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "set-intent", title: "Record the demo video" }));
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "complete-intent" }));
const slowMs = Date.now() - slowStart;
loopSlowMs = 0;
const loopsBefore = loopCalls.length;
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "set-intent", title: "Record the demo video" }));
const demoTab = await ctx.newPage();
await demoTab.goto(repo);
await demoTab.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
const planned = await popup.evaluate(async () => {
  for (let i = 0; i < 100; i++) {
    const { intent } = await chrome.runtime.sendMessage({ type: "get-status" });
    if (intent?.plan) return intent;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
});
const planCalls = loopCalls.slice(loopsBefore).filter((c) => /just set a goal/.test(c.messages[0].content));
await demoTab.locator("#tuck-companion .avatar").click();
const demoCard = demoTab.locator("#tuck-companion .bubble");
await demoCard.locator(".goalcard .dots").waitFor({ timeout: 5000 });
const demoCardText = await demoCard.innerText();
const beforeDemoDrift = await lastTrigger();
// #61: the bubble's "I'm stuck" runs while Tuck is tucked away: the drift word still comes,
// and the step the person asks for shows too.
await popup.evaluate(() => chrome.storage.local.set({ tuckAway: true }));
const demoVideo = await ctx.newPage();
await demoVideo.goto(video);
await demoVideo.bringToFront();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "record-active" }));
await waitForNewDrift(beforeDemoDrift?.id);
const demoWord = nudgeCalls.findLast((m) => /Their task: Record the demo video/.test(m[1].content));
// #61: "I'm stuck" in the drift bubble. A double click asks once. Tuck shows one step, and
// the drift words still due (L2, L3 come 4 s apart here) do not replace it. Start this
// makes it the next step, brings the work tab to the front, and Tuck, tucked away, leaves.
const stuckRuns = () =>
  loopCalls.filter(
    (c) => /stuck on their goal/.test(c.messages[0].content) && !c.messages.some((m) => m.role === "tool"),
  ).length;
const stuckRunsBefore = stuckRuns();
const stuckBubble = demoVideo.locator("#tuck-companion .bubble");
await stuckBubble.locator("button[data-choice=stuck]").dblclick();
await stuckBubble.locator("button[data-choice=start]").waitFor({ timeout: 25000 });
await demoVideo.waitForTimeout(9000);
const stuckKept = await stuckBubble.locator("button[data-choice=start]").isVisible();
const stuckShown = await stuckBubble.innerText();
const stuckAsked = stuckRuns() - stuckRunsBefore;
await stuckBubble.locator("button[data-choice=start]").click();
await popup.waitForTimeout(800);
const stuckBackTo = await activeUrl();
const stuckAwayLeft = (await demoVideo.locator("#tuck-companion .dock.in").count()) === 0;
const afterStart = (await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }))).intent;
await popup.evaluate(() => chrome.storage.local.set({ tuckAway: false }));
// The popup's card: the step shows inline, I'm stuck stays off while it shows, Another one
// once, then it is gone.
await popup.bringToFront();
await popup.reload();
await popup.click("#stuck");
await popup.locator("#stuck-answers:not([hidden])").waitFor({ timeout: 25000 });
const popupStuckOff = await popup.locator("#stuck").isDisabled();
await popup.click("#another-step");
await popup.locator("#stuck-answers:not([hidden])").waitFor({ timeout: 25000 });
const popupStuck = await popup.evaluate(() => ({
  text: document.getElementById("stuck-text").textContent,
  minutes: document.getElementById("stuck-min").textContent,
  another: !document.getElementById("another-step").hidden,
  off: document.getElementById("stuck").disabled,
}));
await popup.click("#start-step");
await popup.waitForTimeout(800);
const popupBackTo = await activeUrl();
const afterPopupStart = (await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }))).intent;
// A failed ask puts the card back.
await popup.bringToFront();
await popup.reload();
await popup.evaluate(() => {
  const real = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (m) => (m?.type === "stuck" ? Promise.reject(new Error("no worker")) : real(m));
});
await popup.click("#stuck");
await popup.waitForTimeout(300);
const popupFailed = await popup.evaluate(() => ({
  on: !document.getElementById("stuck").disabled,
  card: document.getElementById("stuck-view").hidden,
}));
await settingsPage.bringToFront();
await settingsPage.reload();
await settingsPage.locator("#agent-runs .agent-run").first().waitFor({ timeout: 5000 });
const trailText = await settingsPage.locator("#agent-runs").innerText();
// The goal changes with a step on the card: the card clears, and Start this for the old
// goal does nothing.
await popup.bringToFront();
await popup.reload();
await popup.click("#stuck");
await popup.locator("#stuck-answers:not([hidden])").waitFor({ timeout: 25000 });
const oldGoalId = afterPopupStart.id;
await popup.click("#done");
await popup.fill("#title", "Cut the demo video");
await popup.click("#intent-form button[type=submit]");
await popup.locator("#intent-view:not([hidden])").waitFor({ timeout: 5000 });
const popupCleared = await popup.locator("#stuck-view").isHidden();
const lateStart = await popup.evaluate(
  (intentId) => chrome.runtime.sendMessage({ type: "start-step", step: "Old goal step", intentId }),
  oldGoalId,
);
const afterLate = (await popup.evaluate(() => chrome.runtime.sendMessage({ type: "get-status" }))).intent;
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "complete-intent" }));
await demoVideo.close();
await demoTab.close();

// #91: with a repository listed in Settings, a plan step naming a PR merged on GitHub is
// left out before it lands, and "What Tuck looked at" says so. GitHub is faked here; the
// worker's fetch reaching it shows the extension's CSP lets it through.
const githubAsked = [];
await ctx.route("https://api.github.com/**", (route) => {
  const url = new URL(route.request().url());
  githubAsked.push(url.pathname);
  const n = Number(url.pathname.match(/\/issues\/(\d+)$/)?.[1]);
  const issue =
    n === 41
      ? {
          number: 41,
          title: "Fix the checkout total",
          state: "closed",
          closed_at: "2026-11-02T10:00:00Z",
          pull_request: { merged_at: "2026-11-02T10:00:00Z" },
        }
      : n === 12
        ? {
            number: 12,
            title: "Add the cart badge",
            state: "open",
            created_at: "2026-11-03T10:00:00Z",
            pull_request: { merged_at: null },
          }
        : null;
  return route.fulfill({
    status: issue ? 200 : 404,
    contentType: "application/json",
    body: JSON.stringify(issue ?? { message: "Not Found" }),
  });
});
await settingsPage.bringToFront();
await settingsPage.reload();
// Settings fills its fields as it loads: Page reading's list comes after this one.
await settingsPage.waitForFunction(() => document.getElementById("never-read").value !== "");
await settingsPage.fill("#github-repos", "https://github.com/acme-demo/shop\nnot a repo");
await settingsPage.click("#save-github");
const githubBad = await settingsPage.locator("#github-status").innerText();
await settingsPage.fill("#github-repos", "acme-demo/shop");
await settingsPage.click("#save-github");
const githubSaved = await settingsPage.locator("#github-status").innerText();
const githubStored = await settingsPage.evaluate(
  async () => (await chrome.storage.local.get("githubRepos")).githubRepos,
);
if (shots)
  await settingsPage
    .locator("#github-repos")
    .locator("xpath=ancestor::section")
    .screenshot({ path: path.join(shots, "settings-github.png") });
await settingsPage.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  await (
    await Memory.open()
  ).add({
    kind: "decision",
    topic: "shop",
    title: "Shop release",
    context: "The shop ships on Friday.",
    result: "Review PR #41 and PR #12 before the release.",
    next: "none",
  });
  await chrome.runtime.sendMessage({ type: "memory-changed" });
});
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "set-intent", title: "Ship the shop release" }));
const shopPlanned = await popup.evaluate(async () => {
  for (let i = 0; i < 100; i++) {
    const { intent } = await chrome.runtime.sendMessage({ type: "get-status" });
    if (intent?.plan) return intent;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
});
await settingsPage.reload();
await settingsPage.locator("#agent-runs .agent-run").first().waitFor({ timeout: 5000 });
const githubTrail = await settingsPage.locator("#agent-runs").innerText();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "complete-intent" }));
await settingsPage.evaluate(() => chrome.storage.local.remove("githubRepos"));

// #95: with a brain folder connected, Done on a row writes one event to its inbox; Not a
// task writes nothing.
const doneInbox = await settingsPage.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  const memory = await Memory.open();
  const brain = await (await navigator.storage.getDirectory()).getDirectoryHandle("brain-done", { create: true });
  await memory.connectBrain(brain);
  const note = (id, title, topic) =>
    [
      "---",
      `title: "${title}"`,
      "kind: todo",
      `topic: ${topic}`,
      "date: 2026-10-28",
      "source: test",
      `id: ${id}`,
      "---",
      "",
      "- **Context:** A form for the grant.",
      "- **Decision/Result:** Drafted.",
      "- **Evidence:** none",
      "- **Next action:** Send it",
    ].join("\n");
  await memory.importFiles([
    { path: "notes/log/2026/grant.md", text: note("grant01", "Send the grant form", "grants") },
    { path: "notes/log/2026/chore.md", text: note("chore01", "Water the office plant", "office") },
  ]);
  await chrome.runtime.sendMessage({ type: "memory-changed" });
  await chrome.runtime.sendMessage({ type: "reminder-answer", id: "grant01", choice: "done" });
  await chrome.runtime.sendMessage({ type: "reminder-answer", id: "chore01", choice: "not_task" });
  await memory.maintain(); // consolidate, then export to the folder
  const files = [];
  for await (const [, h] of (await brain.getDirectoryHandle("inbox", { create: true })).entries())
    if (h.kind === "file") files.push(await (await h.getFile()).text());
  return files.filter((t) => /marked done in Tuck|Water the office plant/.test(t));
});

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

// The agent loop (#81, #78).
assert.ok(slowMs < 3000, `setting and finishing a goal never wait for the agent (${slowMs} ms)`);
assert.ok(planCalls.length >= 2, "the plan took a lookup, then a finish");
assert.ok(planCalls[0].tools.includes("recall_notes") && planCalls[0].tools.includes("make_plan"));
assert.match(planCalls[1].messages.find((m) => m.role === "tool").content, /Demo video rules/, "the notes are read");
assert.deepEqual(
  planned?.plan?.steps.map((x) => x.step),
  ["Write a 3-minute demo script", "Record the demo video in one take", "Check no API key is on screen"],
);
assert.equal(planned.steps[0], "Write a 3-minute demo script", "the plan's first step is the goal's step");
// The card shows the step on now and the plan as dots (dock-chat design, B).
assert.match(demoCardText, /NOW\s+Write a 3-minute demo script/, "the plan's first step is Tuck's NOW");
assert.match(demoCardText, /1 of 3/, "the plan is on Tuck's card as its progress");
assert.match(demoWord?.[1].content ?? "", /Next step: Write a 3-minute demo script/, "the drift word has the step");
assert.equal(stuckAsked, 1, "a double click on I'm stuck asks once");
assert.ok(stuckKept, "the drift words still due do not replace the step");
assert.ok(stuckAwayLeft, "tucked away, Tuck leaves with Start this");
assert.match(stuckShown, /Write the first lines of the demo video/, "I'm stuck shows the agent's step");
assert.match(stuckShown, /About 10 min/);
assert.equal(afterStart.steps[0], "Write the first lines of the demo video", "Start this makes it the next step");
assert.equal(stuckBackTo, repo, "Start this brings the work tab to the front");
assert.equal(popupStuck.text, "Write the first lines of the demo video", "the popup shows the step inline");
assert.equal(popupStuck.minutes, "About 10 min");
assert.equal(popupStuck.another, false, "Another one asks once more at most");
assert.equal(afterPopupStart.steps[0], popupStuck.text, "the popup's Start this makes it the next step");
assert.equal(popupBackTo, repo, "the popup's Start this brings the work tab to the front");
assert.ok(popupStuckOff && popupStuck.off, "I'm stuck stays off while the popup shows a step");
assert.deepEqual(popupFailed, { on: true, card: true }, "a failed ask puts the button and the card back");
assert.ok(popupCleared, "a new goal clears the popup's step");
assert.equal(lateStart.ok, false, "Start this for a goal that ended does nothing");
assert.notEqual(afterLate.steps?.[0], "Old goal step");
assert.match(trailText, /Planned the goal/);
assert.match(trailText, /recall_notes "record the demo video" → \d+ notes?/);
assert.match(trailText, /You were stuck/);
assert.match(trailText, /recent_activity → \d+ pages?/);
assert.doesNotMatch(trailText, /at most 3 minutes/, "the trail never shows a note's text");
assert.ok(types.has("agent"), "agent runs are in the event log");
// #91: the GitHub check.
assert.match(githubBad, /Not a repository: not a repo/);
assert.match(githubSaved, /Saved\. 1 repository is checked/);
assert.deepEqual(githubStored, ["acme-demo/shop"]);
assert.ok(githubAsked.includes("/repos/acme-demo/shop/issues/41"), JSON.stringify(githubAsked));
assert.deepEqual(
  shopPlanned?.plan?.steps.map((x) => x.step),
  ["Review PR #12 for the shop release", "Write the shop release notes"],
  "the step naming the merged PR is left out",
);
assert.match(githubTrail, /github_check "acme-demo\/shop#41" → merged, left out/);
fs.rmSync(profile, { recursive: true, force: true });

assert.deepEqual(errors, []);
// Issue #46: one entry per goal, in the record format, with no page title in it.
assert.equal(launchEntries.length, 1, JSON.stringify(launchEntries));
assert.equal(launchEntries[0].title, `Day ${launch.date}: Plan the launch: 2h10 on goal, 0 drifts`);
assert.equal(launchEntries[0].kind, "event");
assert.equal(launchEntries[0].next, "none");
assert.match(launchEntries[0].result, /Last work on github\.com\./);
assert.doesNotMatch(JSON.stringify(launchEntries[0]), /launch-plan|acme/);
assert.equal(launchEntriesLater.length, 1, "a later start writes no second entry");
assert.equal(morning, "Yesterday: 2h 10m on plan the launch, last on GitHub.");
assert.equal(nextMorning, "Two hours on the launch plan last time. Pick it up?");
const launchPrompt = greetCalls.map((m) => m.at(-1).content).find((c) => /Their task: Plan the launch/.test(c));
assert.match(launchPrompt, /Last time: 130 minutes on it, not finished, last on GitHub/);
assert.match(launchPrompt, /Last work page: launch-plan\.md · acme\/launch/);
// The goal the test worked on all along, closed when another replaced it.
assert.equal(checkoutEntries.length, 1, JSON.stringify(checkoutEntries));
assert.match(checkoutEntries[0].title, /^Day \d{4}-\d{2}-\d{2}: Fix the checkout bug: \dh\d\d on goal, \d+ drifts?$/);
assert.ok(!/ 0 drifts$/.test(checkoutEntries[0].title), checkoutEntries[0].title);
assert.match(checkoutEntries[0].result, /^Not finished; another goal replaced it\./);
assert.doesNotMatch(JSON.stringify(checkoutEntries[0]), /cart\.js|F1 crashes|Social|Messages|acme/);
assert.match(failedRows, /Water the plants/);
assert.doesNotMatch(failedRows, /Errand|Cart conversion/, "a failed run lists no raw note as a task");
for (const status of [failedStatus, failedStatusLater]) {
  assert.match(status, /could not read your notes yet/);
  assert.match(status, /notes with a next action are not listed/);
}
assert.match(failedStatus, /reply cut at max_tokens \(length\)/);
assert.match(failedStatusLater, /reply cut at max_tokens \(length\)/);
assert.match(partialRows, /Run errand/);
assert.doesNotMatch(partialRows, /Rent went up/, "with some entries judged, an unread one is still not listed");
assert.match(partialStatus, /1 note with a next action/);
assert.equal(greeting, "Hi. What are we working on today?");
assert.equal(greetState, "hello");
assert.match(
  greetStrip ?? "",
  /tuck\/skins\/kitten\/frames\/hello\.png$/,
  "the greeting plays the kitten's waving strip",
);
assert.equal(bubbleLook.bg, "rgb(255, 248, 252)", "the bubble is the skin's surface");
assert.ok(motion.always > 1, `"Always animate" plays the strip under reduce motion: ${motion.always} frames`);
assert.equal(motion.follow, 1, "following the computer's reduce motion holds one frame");
assert.deepEqual(noGoal, { formOnNewTab: 1, formAfterClosing: 0 }, "no goal: the form on a new page, then quiet");
assert.equal(bubbleLook.primaryBg, "rgb(201, 179, 242)", "the primary button is the skin's accent");
assert.match(ringLook.filter, /drop-shadow\(rgb\(255, 255, 255\) 0px 0px 0\.6px\)/, "the rim shows on the page");
assert.match(ringLook.filter, /drop-shadow\(rgba\(0, 0, 0, 0\.18\) 0px 2px 6px\)/, "with the soft shadow");
assert.equal(ringLook.inputFocused, true, "the goal box has focus, so its ring is drawn");
assert.equal(ringLook.inputRing, ringLook.ink, "the focus ring is the ink colour");
// A focus-visible rule that draws a ring (outline); others show a tooltip or a fill.
const drawnRings = ringLook.rings.filter((r) => /outline:/.test(r));
assert.equal(drawnRings.length, 5, `avatar, buttons, ×, inputs and the icon row: ${drawnRings}`);
for (const ring of drawnRings)
  assert.match(ring, /outline: 2px solid var\(--tk-ink\)/, `every focus ring is ink: ${ring}`);
assert.match(ringLook.reducedSlide, /^0s(, 0s)*$/, "no slide-in with reduced motion");
assert.ok(bubbleLook.hostAt >= 0, "the overlay's own CSS marker was found, so the colour check is not vacuous");
assert.doesNotMatch(
  bubbleLook.styleText.slice(bubbleLook.hostAt),
  /#[0-9a-f]{3,6}\b/i,
  "the bubble CSS has no literal colours",
);
assert.equal(restState, "rest", "Tuck rests on the page once the goal is set");
assert.deepEqual(
  afterReload,
  { state: "rest", formOpen: false, shown: 1, hosts: 1 },
  "after a reload Tuck is back on the page, resting, once",
);
assert.equal(clickState, "hello", "clicking Tuck is a hello");
assert.equal(goalChatTrails, 0, "with no notes, the goal chat looks nothing up");
assert.ok(dragged.x < 100, `dragged to the left: ${dragged.x}`);
assert.ok(bubbleAfterDrag.x >= dragged.x, "on the left, the bubble opens rightwards");
assert.ok(formStillOpen, "a drag is not a click");
assert.ok(videoAvatar.x < 100, `Tuck remembers where it was put: ${videoAvatar.x}`);
assert.equal(intentShown, "Fix the checkout bug");
assert.equal(drift1.level, 1);
assert.equal(firstState, "drift", "the first detection is a visible drift pose");
assert.equal(firstText, "Still on the video? Back to the failing test.", "Tuck says the model's line");
assert.ok(nudgeCalls.length >= 1);
assert.match(nudgeCalls[0][1].content, /Site now: localhost/);
assert.match(nudgeCalls[0][1].content, /Next step: Write the failing checkout test/);
assert.ok(secondWord, "the L2 word was drawn");
assert.equal(nudgeState, "drift");
assert.equal(paperIcon, "tuck/skins/paper/icons/16.png", "the toolbar icon follows the skin");
assert.ok(paperKeepsBubble, "a new skin keeps the word on screen, buttons and all");
assert.equal(paperAfterStaleWord, 1, "a word read before the look change does not bring the old skin back");
assert.ok(frisbeeKeepsBubble, "a new item keeps the word on screen");
// The day's greeting with the goal form; its line is how the last goal went when there was one (#46).
assert.ok(switchedOnGreeting, "switched on with no goal, Tuck greets with the goal form");
assert.equal(popupFallback, 1, "the popup draws the default skin when the stored one is unknown");
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
assert.equal(driftSlowFeed.evidence.url, dockFeedSlow, "a region read that runs out does not make the feed work (#38)");
assert.ok(!looks.some((m) => /Sign in \| Social/.test(m.at(-1).content)), "the login page was not read");
assert.ok(
  log.events.some((e) => e.type === "second_look" && e.skipped === "password"),
  "the skip is in the log",
);
assert.ok(
  looks.some((m) => /Page title: Top 10 F1 crashes/.test(m.at(-1).content)),
  "the video was looked at before its nudges",
);
assert.deepEqual(backAtSpot, { inView: true, focused: true, caret: 5 }, "back at the field, caret where it was (#60)");
assert.ok(spotRing, "a ring shows around it");
assert.ok(spotRingGone, "and goes");
assert.deepEqual(backNever, { y: 0, focus: "BODY" }, "a never-read site: the tab only, as before");
assert.equal(reloadedAt, 0, "the reload starts at the top");
assert.deepEqual(backReload, { y: 1200, focus: "" }, "after a reload the scroll comes back; no password focus");
assert.equal(drift4.kind, "drift", "drift is still caught after a restart");
assert.equal(backAfterRestart, repo, "Take me back still works after a restart");
assert.equal(duringWait.id, beforeWait.id, "no nudge while the agent works");
assert.equal(taxStatus.engine.current.label, "other_commitment");
assert.equal(afterTax.id, beforeTax.id, "no word on a page for another commitment");
assert.equal(taxStatus.engine.state, "focused");
assert.ok(!taxStatus.engine.lastRelevant?.url?.endsWith("/tax"));
assert.equal(waitStatus.engine.state, "agent_working");
assert.equal(waitBadge, "", "waiting for the agent: no drift badge left behind");
assert.ok(duringWait.respondedAt || duringWait.resolvedAt, "nor a drift word left open");
assert.deepEqual(agentPopup, { gotIt: true, back: false, forTask: false });
assert.match(heldBubble, /Muse finished\. Back to the failing test\?/, "a finished turn's word is the model's (#67)");
assert.equal(afterOff.engine.agent.status, "completed");
assert.equal(agentWord.kind, "agent");
assert.match(agentBubble, /Muse is waiting on you\./, "a first wait has no line written ahead: the template, at once");
const agentPrompts = agentCalls.map((m) => m.at(-1).content);
assert.ok(agentPrompts.some((c) => /may still be waiting on them/.test(c) && /Their task: /.test(c)));
assert.ok(agentPrompts.some((c) => /just finished its turn/.test(c)));
assert.ok(
  agentPrompts.every((c) => !/Away from work|is waiting on them/.test(c)),
  "a first wait asks no model",
);
assert.ok(waitGone, "Muse back at work: the word about the wait comes down (#66)");
assert.equal(resumedWord.evidence.agent, "waiting_for_user");
assert.equal(resumedWord.resolvedBy, "agent", "taken back because Muse works again");
assert.equal(resumedBadge, "", "and no badge left behind");
assert.ok(
  log.events.some(
    (e) => e.type === "feedback" && e.kind === "agent_resumed" && e.payload?.triggerId === resumedWord.id,
  ),
  "the log says the word was taken back, and why",
);
assert.equal(workPose, "work", "while the agent works, Tuck on the page works");
assert.equal(workBubble, false, "quietly");
assert.equal(waitPose, "wait", "the agent waiting on you: Tuck waits, with the word");
assert.equal(breakFrom.kind, "drift", "the break is taken from a drift nudge");
assert.deepEqual(onBreak, { pose: "sleep", bubble: false, shown: 1 }, "on a break Tuck stays on the page, asleep");
assert.ok(stoppedOnBreak, "the service worker stopped during the break");
assert.deepEqual(
  afterStopOnBreak,
  { pose: "sleep", bubble: false, fresh: true },
  "a page opened after the worker stopped still shows the break",
);
assert.equal(cardOnBreak, "hello", "the goal card on a break is a hello");
assert.equal(afterCardOnBreak, "sleep", "closing it, Tuck sleeps again: the break goes on");
assert.equal(asleepAtWork, "sleep", "asleep on a work page too, for the whole break");
assert.equal(wokePose, "rest", "the break over on a work page: Tuck wakes quietly");
assert.deepEqual(afterBreak, { bubble: false, trigger: breakFrom.kind, state: "focused" });
assert.equal(agentWorkPose, "work", "the agent starts working: the page in front shows it");
assert.equal(agentWorkBubble, false, "with no bubble");
assert.ok(stoppedWhileWorking, "the service worker stopped while the agent works");
assert.deepEqual(afterStopWorking, { pose: "work", fresh: true }, "a fresh page after the stop shows Tuck working");
assert.equal(afterAgentStops, "rest", "the agent stops: Tuck rests again");
assert.equal(afterDone.intent, null, "no stale goal after change + done");
assert.match(reminderText, /Due today\. Still on your list\?/, "the deadline in Tuck's words");
assert.match(reminderText, /Send the visa papers[\s\S]*Due today/, "the task named before its deadline (#92)");
assert.ok(loopsAfterSaid.visa01.saidOn, "said once it is on screen");
assert.ok(loopsAfterDone.visa01.doneAt, "Done is remembered");
assert.equal(reminderAgain, 0, "and it does not come back");
assert.equal(doneNotesUnconnected, 0, "no brain folder: Done writes nothing to memory");
assert.equal(doneInbox.length, 1, `one inbox file for Done, none for Not a task: ${doneInbox}`);
assert.match(doneInbox[0], /^kind: event$/m);
assert.match(doneInbox[0], /^topic: grants$/m);
assert.match(doneInbox[0], /^title: "Send the grant form — marked done in Tuck"$/m);
assert.match(doneInbox[0], /^Decision\/Result: Marked done on \d{4}-\d{2}-\d{2}\. Entries: grant01\.$/m);
assert.match(doneInbox[0], /^Next action: none$/m);
assert.equal(driftMaybe.evidence.unsure, true, "Tuck asks on a page it is unsure about");
assert.equal(askedTasks, 2, "eleven open loops, two calls of at most 10");
assert.equal(taskRows, 7, "the first 7 in sight");
assert.match(showAllLabel, /Show all 9/, "the rest behind Show all");
assert.match(allTaskText, /Run errand 1\b[\s\S]*Run errand 9/, "the node's titles, newest first");
assert.doesNotMatch(allTaskText, /conversion|venue|Book the/i, "no watch note, and no task a later note closed");
assert.doesNotMatch(taskTextAfter, /Run errand 1\b/, "Not a task holds over a re-import");
assert.match(taskTextAfter, /Run errand 2/);
assert.equal(askedAgain, 0, "a re-import with nothing new asks nothing");
assert.equal(groupedRows, 2, "the Lyon tickets and the Rome trip: one row each");
assert.equal(romeFolded, 1, "a row only the notes hold is suggested, below the person's own");
assert.match(groupedText, /Lyon[^\n]*\(brain ×2, Vault\)/i, "the row names its sources");
assert.equal(askedPairs, 1, "four candidate pairs, one call");
assert.equal(splitRows, 3, "Not the same: the Rome tasks apart");
assert.doesNotMatch(tripTextAfter, /Lyon/i, "Done on the row took every entry in it off, over a re-import");
assert.match(tripTextAfter, /Rome trip: hotel[\s\S]*Rome trip: flights|Rome trip: flights[\s\S]*Rome trip: hotel/);
const lyonDone = tripLoops.lyon1?.doneAt;
assert.ok(lyonDone && tripLoops.lyon2?.doneAt === lyonDone, "both notes marked");
assert.equal(Object.values(tripLoops).filter((l) => l.doneAt === lyonDone).length, 3, "and the checkbox");
assert.equal(pairsAgain, 0, "a re-import with nothing new asks about no pair");
assert.ok(
  taskCalls.every((m) => !m.at(-1).content.includes(DRAFT)),
  "the task node sees notes and page titles, never what was typed",
);
assert.ok(
  taskCalls.some((m) =>
    /^Their browsing over the last day, for still_open only:\nLast \d+ min/m.test(m.at(-1).content),
  ),
  "the task node gets the day's browsing (#76)",
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
assert.deepEqual(
  away,
  {
    parting: "Okay. Click the toolbar icon to bring me back.",
    flag: true,
    mark: { badge: "zz", title: true },
    here: 0,
    otherWindow: 0,
    olderTab: 0,
    staleDrawn: 1,
    staleOnSwitch: 0,
    clickWhileAway: 0,
    cardWhileAway: 0,
    next: 0,
    driftPose: "drift",
    afterDrift: 0,
    afterAvatarClick: 0,
    avatarAnswer: "dismiss",
    afterClose: 0,
    closeAnswer: "dismiss",
    afterBreakAnswer: 0,
    onBreakPage: 0,
    breakState: "break",
    afterBreakEnds: 0,
    breakOver: true,
    afterRelated: 0,
    agentPose: "wait",
    afterAgent: 0,
    heldCount: 1,
    afterHeld: 0,
    later: 0,
    popupWhileAway: { card: true, text: "Tuck is tucked away.", awayButton: false },
    flagAfterSwitch: false,
    markAfterBack: { badge: "", title: false },
    backInPlace: 1,
    popupAfterBack: { card: false, awayButton: true },
    popupAwayFlag: true,
    afterPopupAway: 0,
    afterPopupAwayOtherWindow: 0,
    flagBackOnNewTab: false,
    backAfterNewTab: 1,
    restingAgain: "rest",
    hiddenAgain: true,
    stoppedWhileAway: true,
    afterStop: 0,
    freshAfterStop: true,
    flagAfterStop: true,
    afterDoneWhileAway: 0,
    flagAfterGreeting: false,
    goalSetWhileWorking: "work",
  },
  "Tuck away",
);
assert.deepEqual(awayRace, { held: true, drawn: 0, flag: true }, "Tuck away waits for a word on its way");
for (const t of ["context", "relevance", "llm", "state", "trigger", "response", "feedback", "session"])
  assert.ok(types.has(t), `log has ${t}: ${[...types]}`);
assert.ok(!log.events.some((e) => String(e.url ?? "").startsWith("chrome-extension:")), "no extension URLs in the log");
console.log("extension e2e: ok");

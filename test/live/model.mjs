// Live check against a real model provider: one ping, one distill on synthetic
// activity, then Tuck's words about Muse (#67) at the effort they are written with. Reads the key from the environment, never from a file:
//   MODEL_API_KEY   required
//   MODEL_PROVIDER  meta-contributor (default) | meta | openrouter | ollama | together | fireworks | baseten | groq | nebius
//   MODEL_BASE_URL, MODEL_ID  optional overrides
import { modelClient } from "../../src/memory/model.js";
import { distillMessages, parseEntries } from "../../src/memory/distill.js";
import { composeNudge } from "../../src/agent/nudge.js";
import { toolClient } from "../../src/memory/model.js";
import { privateSettings } from "../../src/agent/relevance.js";
import { planFor, stuckStep, nextAfter } from "../../src/agent/moments.js";

const complete = modelClient({
  provider: process.env.MODEL_PROVIDER ?? "meta-contributor",
  baseUrl: process.env.MODEL_BASE_URL,
  model: process.env.MODEL_ID,
  apiKey: process.env.MODEL_API_KEY,
});
const date = new Date().toISOString().slice(0, 10);

console.log(
  "ping:",
  JSON.stringify(await complete([{ role: "user", content: "Reply with exactly: pong" }], { maxTokens: 512 })),
);

const messages = distillMessages({
  activityText: [
    "Last 60 min (55 min active):",
    '- github.com: 35 min ("Fix checkout bug · shop-repo", "cart.js · shop-repo")',
    '- youtube.com: 20 min ("Lofi beats to code to")',
  ].join("\n"),
  contextPrompt: "Stated intent (today): Fix checkout bug; next: Write the failing test",
  topics: ["shop"],
  date,
});
const reply = await complete(messages, { maxTokens: 2048 });
const { entries, rejected } = parseEntries(reply, { date });
console.log(JSON.stringify({ entries, rejected }, null, 2));
if (!entries.length && !rejected.length) console.log("(model returned [] — nothing worth keeping)");

// An agent word is the model's only when its line is written before it is due (background/index.js).
const task = { title: "Fix the checkout bug", step: "Write the failing test" };
for (const agent of [
  { status: "completed", folder: "shop-repo", minutes: 4 },
  { status: "waiting_for_user", folder: "shop-repo", minutes: 2, tool: "run a command" },
  { status: "waiting_for_user", folder: "shop-repo", again: true },
  { status: "failed", folder: "shop-repo", minutes: 11 },
]) {
  const r = await composeNudge(complete, { kind: "agent", agent, task, onWork: false, hour: 15 }, { effort: "low" });
  console.log(`agent word (${agent.status}${agent.again ? ", again" : ""}):`, JSON.stringify(r));
}

// The agent loop (#81) on invented notes: does the real model look things up before it
// proposes, and how long does each step take? Through privateSettings, as in the extension.
const chat = toolClient(
  privateSettings({
    provider: process.env.MODEL_PROVIDER ?? "meta-contributor",
    baseUrl: process.env.MODEL_BASE_URL,
    model: process.env.MODEL_ID,
    apiKey: process.env.MODEL_API_KEY,
  }),
);
let stepMs = [];
const timed = (c) => async (messages, opts) => {
  const t = Date.now();
  try {
    return await c(messages, opts);
  } finally {
    stepMs.push(Date.now() - t);
  }
};
const deps = {
  recall: async (q) =>
    /demo|video|hackathon/i.test(q)
      ? [
          {
            title: "Hackathon demo video rules",
            topic: "meta-hackathon",
            text: "The demo video is at most 3 minutes. Judges weigh the demo at 25%. Never show the API key on screen. Show Tuck catching one drift and the plan.",
          },
          { title: "Video tools", topic: "meta-hackathon", text: "Record with OBS at 1080p; cut in Shotcut." },
        ]
      : [],
  tasks: async () => [
    { id: "visa01", title: "Send the visa papers", when: "in 2 days" },
    { id: "tax02", title: "File the tax form", when: "in 5 days" },
  ],
  activity: async () => [
    { title: "demo-script.md · Google Docs", host: "docs.google.com", label: "related", minutesAgo: 3 },
    { title: "Top 10 F1 crashes", host: "youtube.com", label: "unrelated", minutesAgo: 1 },
  ],
  page: async () => ({ title: "demo-script.md · Google Docs", excerpt: "Intro (0:00-0:20): the problem. Scene 1: " }),
  goal: async () => ({ title: "Record the hackathon demo video", step: null }),
};
for (const [name, run] of [
  ["plan", () => planFor(timed(chat), deps, { title: "Record the hackathon demo video" })],
  ["stuck", () => stuckStep(timed(chat), deps, { title: "Record the hackathon demo video" })],
  ["next", () => nextAfter(timed(chat), deps, { title: "Record the hackathon demo video" })],
]) {
  stepMs = [];
  const r = await run();
  const read = r.trail.findIndex((t) => !/make_plan|no_plan|propose_step|suggest_next/.test(t.tool));
  const fin = r.trail.findIndex((t) => /make_plan|no_plan|propose_step|suggest_next/.test(t.tool));
  console.log(
    `agent ${name}:`,
    JSON.stringify({
      source: r.source,
      readBeforeFinish: read >= 0 && (fin < 0 || read < fin),
      tools: r.trail.map((t) => `${t.tool}${t.result ? ` → ${t.result}` : ""}`),
      stepMs,
      latencyMs: r.latencyMs,
      value: r.value,
      ...(r.error && { error: r.error }),
    }),
  );
}

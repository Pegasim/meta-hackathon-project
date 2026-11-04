// Live check against a real model provider: one ping, one distill on synthetic
// activity, then Tuck's words about Muse (#67) at the effort they are written with. Reads the key from the environment, never from a file:
//   MODEL_API_KEY   required
//   MODEL_PROVIDER  meta-contributor (default) | meta | openrouter | ollama | together | fireworks | baseten | groq | nebius
//   MODEL_BASE_URL, MODEL_ID  optional overrides
import { modelClient } from "../../src/memory/model.js";
import { distillMessages, parseEntries } from "../../src/memory/distill.js";
import { composeNudge } from "../../src/agent/nudge.js";

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

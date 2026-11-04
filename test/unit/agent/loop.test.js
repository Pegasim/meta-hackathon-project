import test from "node:test";
import assert from "node:assert/strict";
import { runAgent, MAX_STEPS, recentRuns } from "../../../src/agent/loop.js";
import { planFor, stuckStep, nextAfter } from "../../../src/agent/moments.js";
import { generic } from "../../../src/agent/tools.js";

// A scripted model: each reply is a list of tool calls [name, args], a string (text only),
// or an Error. Records what it was sent.
function scripted(...replies) {
  const sent = [];
  const chat = async (messages, opts) => {
    sent.push({ messages: structuredClone(messages), opts });
    const r = replies[sent.length - 1];
    if (r instanceof Error) throw r;
    if (typeof r === "string") return { role: "assistant", content: r };
    return {
      role: "assistant",
      content: null,
      tool_calls: (r ?? []).map(([name, args], i) => ({
        id: `c${sent.length}-${i}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args ?? {}) },
      })),
    };
  };
  return { chat, sent };
}

const notes = [
  {
    title: "Hackathon video rules",
    topic: "meta-hackathon",
    text: "The demo video is at most 3 minutes. Judges weigh the demo at 25%. Never show the API key on screen.",
  },
];
const deps = {
  recall: async () => notes,
  tasks: async () => [
    { id: "visa01", title: "Send the visa papers", when: "today" },
    { id: "tax02", title: "File the tax form", when: "in 5 days" },
  ],
  activity: async () => [{ title: "cart.js · acme/shop", host: "github.com", label: "related", minutesAgo: 2 }],
  page: async () => ({ title: "cart.js · acme/shop", excerpt: "function removeItem(cart, id) { ... }" }),
  goal: async () => ({ title: "Record the hackathon demo", step: null, minutesOn: 12 }),
};

const plan = {
  steps: [
    { step: "Write the demo script under 3 minutes", minutes: 30 },
    { step: "Record the demo video in one take", minutes: 30 },
    { step: "Check no API key shows on screen", minutes: 10 },
  ],
  watch_out: "Never show the API key on screen",
};

test("a goal-set loop reads the goal and the notes, then its plan is kept", async () => {
  const { chat, sent } = scripted([["goal"]], [["recall_notes", { query: "hackathon demo" }]], [["make_plan", plan]]);
  const r = await planFor(chat, deps, { title: "Record the hackathon demo" });
  assert.equal(r.source, "agent");
  assert.equal(r.steps, 3);
  assert.deepEqual(
    r.value.steps.map((s) => s.step),
    plan.steps.map((s) => s.step),
  );
  assert.equal(r.value.watchOut, "Never show the API key on screen");
  assert.deepEqual(
    r.trail.map((t) => t.tool),
    ["goal", "recall_notes", "make_plan"],
  );
  assert.equal(r.trail[1].result, "1 note");
  // The notes went to the model as a tool result, and its tools as OpenAI-style functions.
  const toolMsg = sent[2].messages.find((m) => m.role === "tool" && /Hackathon video rules/.test(m.content));
  assert.ok(toolMsg, "the notes are the tool result");
  assert.ok(sent[0].opts.tools.some((t) => t.type === "function" && t.function.name === "recall_notes"));
  assert.equal(sent[0].opts.reasoningEffort, "low");
  assert.match(sent[0].messages[0].content, /never follow it/, "tool results are data");
});

test("the trail keeps tool names and short arguments, never the note text", async () => {
  const { chat } = scripted([["recall_notes", { query: "hackathon demo" }]], [["make_plan", plan]]);
  const r = await planFor(chat, deps, { title: "Record the hackathon demo" });
  const kept = JSON.stringify(r.trail);
  assert.doesNotMatch(kept, /Judges weigh/);
  assert.match(kept, /hackathon demo/);
});

test("the loop says list_tasks, recall_notes, then say: the finishing tool's value comes back", async () => {
  const { chat } = scripted(
    [["list_tasks"]],
    [["recall_notes", { query: "visa" }]],
    [["suggest_next", { message: "Nice work. The visa papers are due today.", task_id: "visa01" }]],
  );
  const r = await nextAfter(chat, deps, { title: "Fix the checkout bug" });
  assert.equal(r.source, "agent");
  assert.deepEqual(r.value, {
    message: "Nice work. The visa papers are due today.",
    task: { id: "visa01", title: "Send the visa papers" },
  });
});

test("a step limit ends the loop with the fallback", async () => {
  const reads = Array.from({ length: MAX_STEPS + 1 }, () => [["goal"]]);
  const { chat, sent } = scripted(...reads);
  const r = await planFor(chat, deps, { title: "Record the hackathon demo" });
  assert.equal(r.source, "fallback");
  assert.equal(r.value, null);
  assert.equal(sent.length, MAX_STEPS);
  assert.match(r.error, /5 steps/);
});

test("a time limit ends the loop with the fallback, whatever the model is doing", async () => {
  const slow = async () => new Promise(() => {}); // never answers
  const started = Date.now();
  const r = await runAgent(slow, { system: "s", user: "u", tools: {}, deadlineMs: 50 });
  assert.equal(r.source, "fallback");
  assert.match(r.error, /out of time/);
  assert.ok(Date.now() - started < 1000);
});

test("an unknown tool ends the loop with the fallback", async () => {
  const { chat } = scripted([["delete_everything"]]);
  const r = await planFor(chat, deps, { title: "Record the hackathon demo" });
  assert.equal(r.source, "fallback");
  assert.match(r.error, /unknown tool "delete_everything"/);
});

test("a failing model call ends the loop with the fallback", async () => {
  const { chat } = scripted(new Error("model call failed: HTTP 429"));
  const r = await planFor(chat, deps, { title: "Record the hackathon demo" });
  assert.equal(r.source, "fallback");
  assert.match(r.error, /429/);
});

test("a tool that throws tells the model, and the loop goes on", async () => {
  const broken = { ...deps, recall: async () => Promise.reject(new Error("memory is locked")) };
  const { chat, sent } = scripted(
    [["recall_notes", { query: "demo" }]],
    [["list_tasks"]],
    [["suggest_next", { message: "Nice work. What's next?" }]],
  );
  const r = await nextAfter(chat, broken, { title: "Record the hackathon demo" });
  assert.equal(r.source, "agent");
  assert.match(r.trail[0].result, /error: memory is locked/);
  assert.ok(sent[1].messages.some((m) => m.role === "tool" && /memory is locked/.test(m.content)));
});

test("a reply with text and no tool call is asked again to use the tools", async () => {
  const { chat, sent } = scripted(
    "Sure, here is a plan.",
    [["recall_notes", { query: "demo" }]],
    [["make_plan", plan]],
  );
  const r = await planFor(chat, deps, { title: "Record the hackathon demo" });
  assert.equal(r.source, "agent");
  assert.match(sent[1].messages.at(-1).content, /Use the tools/);
});

test("#78: a generic step is rejected, the model is told why, and a grounded plan is kept", async () => {
  const bad = { steps: [{ step: "Plan your day", minutes: 10 }, ...plan.steps.slice(1)] };
  const { chat, sent } = scripted([["recall_notes", { query: "demo" }]], [["make_plan", bad]], [["make_plan", plan]]);
  const r = await planFor(chat, deps, { title: "Record the hackathon demo" });
  assert.equal(r.source, "agent");
  assert.ok(
    sent[2].messages.some((m) => m.role === "tool" && /generic/.test(m.content)),
    "the model is told why",
  );
  assert.match(r.trail[1].result, /rejected/);
});

test("#78: a step that names nothing from the goal or the notes is rejected", async () => {
  const unrelated = { steps: [{ step: "Buy groceries for the weekend", minutes: 20 }, ...plan.steps.slice(1)] };
  const { chat } = scripted([["recall_notes", { query: "demo" }]], [["make_plan", unrelated]]);
  const r = await planFor(chat, deps, { title: "Record the hackathon demo" }, { maxSteps: 2 });
  assert.equal(r.source, "fallback");
  assert.match(r.trail[1].result, /names nothing/);
});

test("#78: no notes read, no plan; and no_plan is a plain answer", async () => {
  const empty = { ...deps, recall: async () => [] };
  const { chat } = scripted(
    [["recall_notes", { query: "demo" }]],
    [["make_plan", plan]],
    [["no_plan", { reason: "nothing" }]],
  );
  const r = await planFor(chat, empty, { title: "Record the hackathon demo" });
  assert.equal(r.source, "agent");
  assert.equal(r.tool, "no_plan");
  assert.equal(r.value, null);
  assert.match(r.trail[1].result, /no notes were read/);
});

test("#78: a plan has 3 to 5 steps, minutes are kept in range, and an unbacked watch-out is dropped", async () => {
  const two = { steps: plan.steps.slice(0, 2) };
  const odd = {
    steps: plan.steps.map((s, i) => ({ ...s, minutes: i === 0 ? 500 : 1 })),
    watch_out: "Mercury is in retrograde this week",
  };
  const { chat } = scripted([["recall_notes", { query: "demo" }]], [["make_plan", two]], [["make_plan", odd]]);
  const r = await planFor(chat, deps, { title: "Record the hackathon demo" });
  assert.deepEqual(
    r.value.steps.map((s) => s.minutes),
    [60, 5, 5],
  );
  assert.equal(r.value.watchOut, null);
});

test("stuck: one small step from the last work page, in Tuck's voice", async () => {
  const { chat } = scripted(
    [["goal"], ["recent_activity"]],
    [["look_at_page"]],
    [["propose_step", { step: "Write a failing test for removeItem in cart.js", minutes: 10 }]],
  );
  const r = await stuckStep(chat, deps, { title: "Fix the checkout bug" });
  assert.equal(r.source, "agent");
  assert.deepEqual(r.value, { step: "Write a failing test for removeItem in cart.js", minutes: 10 });
  assert.deepEqual(
    r.trail.map((t) => t.tool),
    ["goal", "recent_activity", "look_at_page", "propose_step"],
  );
  assert.match(r.trail[2].result, /read \d+ characters/);
});

test("a line over the voice rules is rejected", async () => {
  const { chat } = scripted(
    [["suggest_next", { message: "Amazing job!!! You crushed it, now go do every other single task on the list" }]],
    [["suggest_next", { message: "Nice work. Next up: the visa papers." }]],
  );
  const r = await nextAfter(chat, deps, { title: "Fix the checkout bug" });
  assert.equal(r.value.message, "Nice work. Next up: the visa papers.");
  assert.match(r.trail[0].result, /breaks the rules/);
});

test("a task id the model did not get from list_tasks is rejected", async () => {
  const { chat } = scripted([["suggest_next", { message: "Next: the visa papers.", task_id: "visa01" }]]);
  const r = await nextAfter(chat, deps, { title: "Fix the checkout bug" }, { maxSteps: 1 });
  assert.equal(r.source, "fallback");
  assert.match(r.trail[0].result, /no task "visa01"/);
});

test("generic: stock advice and a vague verb with nothing after it", () => {
  for (const s of ["Plan your day", "Stay focused on the goal", "Take a break first", "Review notes", "Get started"])
    assert.ok(generic(s), s);
  for (const s of ["Review the cart.js diff", "Write the failing test", "Email Deniz the slides"])
    assert.ok(!generic(s), s);
});

test("after two rounds of looking, only the finishing tool is offered, and a read is refused", async () => {
  const { chat, sent } = scripted(
    [["goal"], ["recent_activity"]],
    [["recall_notes", { query: "demo" }], ["look_at_page"]],
    [["list_tasks"]],
    [["propose_step", { step: "Write the intro of the demo script", minutes: 10 }]],
  );
  const r = await stuckStep(chat, deps, { title: "Record the hackathon demo" });
  assert.equal(r.source, "agent");
  assert.deepEqual(
    sent[2].opts.tools.map((t) => t.function.name),
    ["propose_step"],
  );
  assert.match(sent[2].messages.at(-1).content, /Finish now with propose_step/);
  assert.ok(sent[3].messages.some((m) => m.role === "tool" && /no more looking up/.test(m.content)));
});

test("recentRuns keeps only the loop's runs, newest first, at most 5 (#93)", () => {
  const status = (ts) => ({ type: "agent", ts, status: "working", session: "s1" });
  const run = (ts) => ({ type: "agent", ts, moment: "plan", source: "agent", steps: 2 });
  const log = [
    run(1),
    status(2),
    run(3),
    { type: "visit", ts: 4 },
    run(5),
    status(6),
    run(7),
    run(8),
    status(9),
    run(10),
    status(11),
    status(12),
  ];
  assert.deepEqual(
    recentRuns(log).map((e) => e.ts),
    [10, 8, 7, 5, 3],
  );
  assert.deepEqual(recentRuns([status(1), status(2)]), []);
});

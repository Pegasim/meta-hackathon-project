import test from "node:test";
import assert from "node:assert/strict";
import { goalTools, stuckTools } from "../../../src/agent/tools.js";
import { goalFrom, chatStep } from "../../../src/agent/moments.js";

function scripted(...replies) {
  let n = 0;
  return async () => {
    const r = replies[n++] ?? [];
    return {
      role: "assistant",
      content: null,
      tool_calls: r.map(([name, args], i) => ({
        id: `c${n}-${i}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args ?? {}) },
      })),
    };
  };
}
const deps = (notes) => ({
  recall: async () => notes,
  tasks: async () => [],
  activity: async () => [],
  page: async () => ({}),
  goal: async () => ({}),
});

test("propose_goal keeps the person's subject", () => {
  const ctx = {
    said: "the investor deck i guess",
    notes: [{ title: "Investor deck", text: "slides 6 to 9 missing the Q3 numbers" }],
  };
  assert.deepEqual(
    goalTools.propose_goal.finish(
      { title: "Finish slides 6 to 9 of the investor deck", step: "Add the Q3 numbers to slide 6" },
      ctx,
    ),
    { title: "Finish slides 6 to 9 of the investor deck", step: "Add the Q3 numbers to slide 6", kept: false },
  );
});

test("propose_goal is rejected when it drops what the person wrote", () => {
  const ctx = { said: "the investor deck", notes: [{ title: "Tax form", text: "due Friday" }] };
  assert.throws(
    () => goalTools.propose_goal.finish({ title: "Send the tax form", step: "Open the tax form" }, ctx),
    /investor deck/,
  );
});

test("propose_goal with no step keeps the goal and no step", () => {
  const ctx = { said: "fix the cart", notes: [] };
  assert.deepEqual(goalTools.propose_goal.finish({ title: "Fix the cart total bug" }, ctx), {
    title: "Fix the cart total bug",
    step: null,
    kept: false,
  });
});

test("keep_goal returns the person's words, trimmed, and Tuck's own reply", () => {
  assert.deepEqual(
    goalTools.keep_goal.finish({ reply: "Nice. What will you touch first?" }, { said: "  fix the cart  " }),
    {
      title: "fix the cart",
      step: null,
      kept: true,
      reply: "Nice. What will you touch first?",
    },
  );
});

test("a reply that breaks Tuck's voice, or none, is rejected, so the model writes it again", () => {
  const ctx = { said: "fix the cart" };
  assert.throws(
    () => goalTools.keep_goal.finish({ reply: "Amazing!!! Let's crush it today, you've got this, champion!" }, ctx),
    /rules/,
  );
  assert.throws(() => goalTools.keep_goal.finish({}, ctx), /reply/);
});

test("propose_goal carries Tuck's reply when the model writes one", () => {
  const ctx = { said: "fix the cart", notes: [] };
  const v = goalTools.propose_goal.finish(
    { title: "Fix the cart total bug", reply: "Your notes say it's the total." },
    ctx,
  );
  assert.equal(v.reply, "Your notes say it's the total.");
});

test("goalFrom with no notes ends with keep_goal, and the model sees the person's words", async () => {
  const r = await goalFrom(
    scripted([["recall_notes", { query: "investor deck" }]], [["keep_goal", { reply: "Got it. Which slide first?" }]]),
    deps([]),
    { said: "the investor deck" },
  );
  assert.equal(r.source, "agent");
  assert.deepEqual(r.value, {
    title: "the investor deck",
    step: null,
    kept: true,
    reply: "Got it. Which slide first?",
  });
});

test("goalFrom offers only notes and tasks to read", async () => {
  let offered;
  const chat = async (messages, opts) => {
    offered = opts.tools.map((t) => t.function.name);
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "keep_goal", arguments: '{"reply":"Okay. Where do you start?"}' },
        },
      ],
    };
  };
  await goalFrom(chat, deps([]), { said: "the investor deck" });
  assert.ok(offered.includes("recall_notes") && offered.includes("keep_goal") && offered.includes("propose_goal"));
  assert.ok(!offered.includes("look_at_page") && !offered.includes("recent_activity"));
});

// What the chat offers the model: with no notes, nothing to read; what the person wrote
// in the chat never reads their page.
const offeredBy = async (run) => {
  let offered;
  const chat = async (messages, opts) => {
    offered ??= { tools: opts.tools.map((t) => t.function.name), user: messages[1].content };
    const name = offered.tools.includes("keep_goal") ? "keep_goal" : "propose_step";
    const args =
      name === "keep_goal"
        ? { reply: "Okay. Where do you start?" }
        : { step: "Write the bubble styles for the chat", minutes: 10 };
    return {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
    };
  };
  const r = await run(chat);
  return { ...offered, r };
};

test("with no notes, the goal chat reads nothing: only the finishing tools", async () => {
  const { tools, r } = await offeredBy((chat) =>
    goalFrom(chat, deps([]), { said: "tuck's chat interface" }, { notes: false }),
  );
  assert.deepEqual(tools.sort(), ["keep_goal", "propose_goal"]);
  assert.equal(r.value.reply, "Okay. Where do you start?");
});

test("what the person writes with a goal running reads their notes only, never the page", async () => {
  const { tools, user } = await offeredBy((chat) =>
    chatStep(chat, deps([]), { title: "Build the chat", step: null, said: "the bubbles look off" }),
  );
  assert.ok(tools.includes("recall_notes"));
  for (const t of ["look_at_page", "recent_activity"]) assert.ok(!tools.includes(t), `${t} is not offered`);
  assert.match(user, /They wrote: the bubbles look off/);
});

test("with no notes, what the person writes gets a step from their words alone", async () => {
  const { tools, r } = await offeredBy((chat) =>
    chatStep(chat, deps([]), { title: "Build the chat", said: "the bubbles look off" }, { notes: false }),
  );
  assert.deepEqual(tools, ["propose_step"]);
  assert.equal(r.value.step, "Write the bubble styles for the chat");
});

test("a step may be built from what the person wrote", () => {
  const v = stuckTools.propose_step.finish(
    { step: "Fix the bubble padding", minutes: 10 },
    { goal: { title: "Ship it" }, said: "the bubble padding is wrong" },
  );
  assert.equal(v.step, "Fix the bubble padding");
});

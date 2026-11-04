import test from "node:test";
import assert from "node:assert/strict";
import { goalTools } from "../../../src/agent/tools.js";
import { goalFrom } from "../../../src/agent/moments.js";

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

test("keep_goal returns the person's words, trimmed", () => {
  assert.deepEqual(goalTools.keep_goal.finish({}, { said: "  fix the cart  " }), {
    title: "fix the cart",
    step: null,
    kept: true,
  });
});

test("goalFrom with no notes ends with keep_goal, and the model sees the person's words", async () => {
  const r = await goalFrom(scripted([["recall_notes", { query: "investor deck" }]], [["keep_goal"]]), deps([]), {
    said: "the investor deck",
  });
  assert.equal(r.source, "agent");
  assert.deepEqual(r.value, { title: "the investor deck", step: null, kept: true });
});

test("goalFrom offers only notes and tasks to read", async () => {
  let offered;
  const chat = async (messages, opts) => {
    offered = opts.tools.map((t) => t.function.name);
    return {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "keep_goal", arguments: "{}" } }],
    };
  };
  await goalFrom(chat, deps([]), { said: "the investor deck" });
  assert.ok(offered.includes("recall_notes") && offered.includes("keep_goal") && offered.includes("propose_goal"));
  assert.ok(!offered.includes("look_at_page") && !offered.includes("recent_activity"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { relevanceMessages, parseRelevance, classifyRelevance, privateSettings } from "../../../src/agent/relevance.js";
import { resolveConfig } from "../../../src/memory/model.js";

const input = {
  intent: { title: "Fix the checkout bug in the shop repo", steps: ["Write the failing test"] },
  url: "https://www.youtube.com/watch?v=abc&t=42",
  title: "Top 10 F1 crashes of all time",
};
const reply = (o) => JSON.stringify(o);

// A fake model: returns the given replies in order and records what it was sent.
function fakeModel(...replies) {
  const calls = [];
  const complete = async (messages, opts) => {
    calls.push({ messages, opts });
    const r = replies[calls.length - 1];
    if (r instanceof Error) throw r;
    return r;
  };
  return { complete, calls };
}

test("a valid reply is parsed and marked as the model's", async () => {
  const { complete, calls } = fakeModel(
    reply({ label: "unrelated", confidence: 0.9, reason: "F1 video, not the bug." }),
  );
  const r = await classifyRelevance(complete, input);
  assert.equal(r.label, "unrelated");
  assert.equal(r.confidence, 0.9);
  assert.equal(r.source, "llm");
  assert.equal(r.retried, false);
  assert.equal(typeof r.latencyMs, "number");
  assert.equal(calls[0].opts.temperature, 0);
});

test("fences and think blocks around the JSON are tolerated", async () => {
  const { complete } = fakeModel('<think>hmm</think>```json\n{"label":"related","confidence":0.8,"reason":"r"}\n```');
  assert.equal((await classifyRelevance(complete, input)).label, "related");
});

test("an invalid reply is retried once with the error", async () => {
  const { complete, calls } = fakeModel("nope", reply({ label: "related", confidence: 0.7, reason: "r" }));
  const r = await classifyRelevance(complete, input);
  assert.equal(r.retried, true);
  assert.equal(r.label, "related");
  assert.match(calls[1].messages.at(-1).content, /Your last reply was invalid/);
});

test("two invalid replies fall back to neutral", async () => {
  const { complete } = fakeModel("nope", "still nope");
  const r = await classifyRelevance(complete, input);
  assert.equal(r.label, "neutral");
  assert.equal(r.confidence, 0);
  assert.equal(r.source, "fallback");
});

test("a failing model call falls back to neutral with the error", async () => {
  const { complete } = fakeModel(new Error("model call failed: HTTP 429"));
  const r = await classifyRelevance(complete, input);
  assert.equal(r.source, "fallback");
  assert.equal(r.label, "neutral");
  assert.match(r.error, /429/);
});

test("parseRelevance names the bad field", () => {
  assert.throws(() => parseRelevance('{"label":"maybe","confidence":1}'), /label/);
  assert.throws(() => parseRelevance('{"label":"related","confidence":1.7}'), /confidence/);
  assert.equal(
    parseRelevance(reply({ label: "neutral", confidence: 0.2, reason: "x".repeat(500) })).reason.length,
    200,
  );
});

test("the prompt carries the goal, host and title but not the query string", () => {
  const user = relevanceMessages(input).at(-1).content;
  assert.match(user, /Fix the checkout bug in the shop repo/);
  assert.match(user, /youtube\.com/);
  assert.match(user, /Top 10 F1 crashes of all time/);
  assert.doesNotMatch(user, /abc|t=42/);
});

test("the person's own labels are given as examples", () => {
  const user = relevanceMessages({
    ...input,
    examples: [{ host: "figma.com", title: "Demo frames", label: "related" }],
  }).at(-1).content;
  assert.match(user, /figma\.com/);
  assert.match(user, /related/);
});

test("what is known about the person reaches the prompt, and is absent without it", () => {
  const profile = { summary: "Builds Bilun, a SUT rules engine.", topics: ["bilun", "meta-hackathon"] };
  const [, withIt] = relevanceMessages({ ...input, profile });
  assert.match(withIt.content, /About them: Builds Bilun, a SUT rules engine\. Their topics: bilun, meta-hackathon\./);

  const [, without] = relevanceMessages(input);
  assert.doesNotMatch(without.content, /About them:/);
});

// ---- The second look (issue #5) ------------------------------------------------

test("with an excerpt the prompt judges what is on screen, not the site", () => {
  const excerpt = "Ayse: so the differentiators are the pet and the terminal link? Me: yes, plus memory import";
  const [system, user] = relevanceMessages({
    ...input,
    url: "https://www.linkedin.com/feed/",
    title: "Feed | LinkedIn",
    excerpt,
  });
  assert.match(system.content, /excerpt/);
  assert.match(system.content, /a conversation about the goal on a\nsocial site is related/);
  assert.match(user.content, /Page excerpt: Ayse: so the differentiators/);
  const [plain] = relevanceMessages(input);
  assert.match(plain.content, /site and title only/, "without an excerpt the prompt is unchanged");
  assert.doesNotMatch(relevanceMessages(input)[1].content, /Page excerpt/);
});

test("page text never goes to Meta's Contributor tier", () => {
  assert.deepEqual(privateSettings({ provider: "meta-contributor", apiKey: "k" }), {
    provider: "meta",
    apiKey: "k",
    model: undefined,
  });
  assert.equal(privateSettings({ apiKey: "k" }).provider, "meta", "an unset provider is plain Meta, never Contributor");
  assert.equal(privateSettings({ provider: "meta-contributor", model: "muse-spark-1.3-contributor" }).model, undefined);
  assert.equal(privateSettings({ provider: "meta-contributor", model: "muse-spark-2" }).model, "muse-spark-2");
  // Review: Contributor typed as the model on plain Meta.
  assert.equal(privateSettings({ provider: "meta", model: "muse-spark-1.3-contributor" }).model, undefined);
  assert.equal(privateSettings({ provider: "meta", model: "fake", baseUrl: "x" }).model, "fake");
  const other = { provider: "openrouter", apiKey: "k" };
  assert.equal(privateSettings(other), other);
});

// Notes reach the prompt only when the search found some (issue #8).
const NOTES = [{ topic: "shop", title: "Checkout fix with Ali", text: "Working with Ali Demir on the checkout bug." }];

test("notes and the person spoken to go into the prompt", () => {
  const [system, user] = relevanceMessages({ ...input, notes: NOTES, conversationWith: "Ali Demir" });
  assert.match(system.content, /own notes/);
  assert.match(user.content, /From their own notes:\n- \[shop\] Checkout fix with Ali: Working with Ali Demir/);
  assert.match(user.content, /In a conversation with: Ali Demir/);
});

test("with no notes the prompt is exactly as before, and a name alone is not sent", () => {
  const plain = relevanceMessages(input);
  assert.deepEqual(relevanceMessages({ ...input, notes: [] }), plain);
  assert.deepEqual(relevanceMessages({ ...input, notes: [], conversationWith: "Ali Demir" }), plain);
});

test("the second look gets the notes too", () => {
  const [system, user] = relevanceMessages({ ...input, excerpt: "see you tomorrow", notes: NOTES });
  assert.match(system.content, /own notes/);
  assert.match(user.content, /Page excerpt: see you tomorrow/);
  assert.match(user.content, /Checkout fix with Ali/);
});

const goal = { title: "Fix the checkout bug in the shop repo" };

test("another commitment is a label of its own, offered only when there are commitments", () => {
  const page = { intent: goal, url: "https://tax.example/form", title: "Tax form" };
  const [plainSystem, plainUser] = relevanceMessages(page);
  assert.doesNotMatch(plainSystem.content, /other_commitment/);
  assert.doesNotMatch(plainUser.content, /commitments/);
  const [system, user] = relevanceMessages({ ...page, commitments: ["File the taxes", "Book the dentist"] });
  assert.match(system.content, /other_commitment/);
  assert.match(user.content, /Their other commitments:\n- File the taxes\n- Book the dentist/);
  assert.equal(parseRelevance('{"label":"other_commitment","confidence":0.8}').label, "other_commitment");
});

test("the second look gets the commitments too", () => {
  const [system, user] = relevanceMessages({
    intent: goal,
    url: "https://tax.example/form",
    title: "Tax form",
    excerpt: "Income for 2026",
    commitments: ["File the taxes"],
  });
  assert.match(system.content, /other_commitment/);
  assert.match(user.content, /File the taxes/);
});

test("other_commitment with no commitments sent is invalid: asked again", async () => {
  const { complete, calls } = fakeModel(
    reply({ label: "other_commitment", confidence: 0.8, reason: "r" }),
    reply({ label: "unrelated", confidence: 0.9, reason: "r" }),
  );
  const r = await classifyRelevance(complete, input);
  assert.equal(r.label, "unrelated");
  assert.equal(r.retried, true);
  assert.match(calls[1].messages.at(-1).content, /label must be one of related\|unrelated\|neutral,/);
  const withList = fakeModel(reply({ label: "other_commitment", confidence: 0.8, reason: "r" }));
  assert.equal(
    (await classifyRelevance(withList.complete, { ...input, commitments: ["File the taxes"] })).label,
    "other_commitment",
  );
});

test("a caller can set the reasoning effort; the retry asks the same way", async () => {
  const { complete, calls } = fakeModel("not json", reply({ label: "related", confidence: 0.8, reason: "x" }));
  await classifyRelevance(complete, input, { effort: "minimal" });
  assert.deepEqual(
    calls.map((c) => c.opts.reasoningEffort),
    ["minimal", "minimal"],
  );
});

test("another part of the goal's own project counts as related, in both prompts", () => {
  const rule = /another part of the same project/;
  assert.match(relevanceMessages(input)[0].content, rule);
  assert.match(relevanceMessages({ ...input, excerpt: "A feed of F1 clips." })[0].content, rule);
});

test("the node asks at low reasoning effort by default", async () => {
  const { complete, calls } = fakeModel(reply({ label: "unrelated", confidence: 0.9, reason: "x" }));
  await classifyRelevance(complete, input);
  assert.equal(calls[0].opts.reasoningEffort, "low");
});

test("on Meta every call, the chat as well as page judgements, resolves to Muse Wonder, never Contributor", () => {
  for (const s of [{ provider: "meta", apiKey: "k" }, { provider: "meta-contributor", apiKey: "k" }, { apiKey: "k" }])
    assert.equal(resolveConfig(privateSettings(s)).model, "muse-wonder-1.0");
  assert.equal(
    resolveConfig(privateSettings({ provider: "meta-contributor", model: "muse-spark-1.3-contributor", apiKey: "k" }))
      .model,
    "muse-wonder-1.0",
  );
});

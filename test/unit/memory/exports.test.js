import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  fromClaudeExport,
  fromGeminiTakeout,
  readExport,
  hasCommitmentCue,
  selectConversations,
  conversationText,
  importExport,
  exportEntries,
  EXPORT_DAYS,
  MAX_EXPORT_CONVERSATIONS,
} from "../../../src/memory/exports.js";
import { MAX_PASTE_CHARS } from "../../../src/memory/paste.js";

const TODAY = "2026-11-03";
const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../fixtures/exports", name), "utf8"));
const claude = fixture("claude-conversations.json");
const gemini = fixture("gemini-MyActivity.json");

test("a Claude export: one conversation per chat, user and assistant text only", () => {
  const all = fromClaudeExport(claude);
  assert.equal(all.length, 6);
  const pantry = all.find((c) => c.id === "c1-pantry");
  assert.equal(pantry.title, "Pantry launch plan");
  assert.equal(pantry.updated, "2026-10-30T18:20:00.000Z");
  assert.deepEqual(
    pantry.turns.map((t) => t.role),
    ["user", "assistant"],
  );
  assert.equal(pantry.turns[1].text, "Here is a plan for the next three weeks.", "a tool call is not text");
  const grant = all.find((c) => c.id === "c6-grant");
  assert.match(grant.turns[0].text, /deadline moved/, "text from the content items when the message text is empty");
  assert.equal(grant.turns.length, 2, "an empty message is dropped");
  const tax = all.find((c) => c.id === "c3-tax");
  assert.ok(!JSON.stringify(tax).includes("Invented attachment text"), "attachment contents stay out");
});

test("a Gemini Takeout: prompts grouped into chats by the app id, replies as plain text", () => {
  const all = fromGeminiTakeout(gemini);
  assert.deepEqual(all.map((c) => c.id).sort(), ["abc123", "def456", "ghi789"]);
  const grant = all.find((c) => c.id === "abc123");
  assert.deepEqual(
    grant.turns.map((t) => t.role),
    ["user", "assistant", "user"],
    "in time order; a prompt without a reply is still the person's",
  );
  assert.match(grant.turns[0].text, /^I need to finish the grant report/);
  assert.equal(grant.turns[1].text, "Here is an outline & a plan:\nBudget\nResults");
  assert.equal(grant.updated, "2026-11-01T10:05:00.000Z");
  assert.match(grant.title, /^I need to finish the grant report/);
  assert.ok(!all.some((c) => c.turns.some((t) => /feedback/i.test(t.text))), "feedback events are not prompts");
});

test("readExport tells the two apart, and refuses anything else", () => {
  assert.equal(readExport(claude).kind, "claude");
  assert.equal(readExport(gemini).kind, "gemini");
  assert.throws(() => readExport({ conversations: [] }), /not a Claude or Gemini export/);
  assert.throws(() => readExport([{ foo: 1 }]), /not a Claude or Gemini export/);
});

test("commitment cues: dates, deadlines and to-dos, in English and Turkish", () => {
  for (const yes of [
    "Ship it by 2026-11-20",
    "It is due 15 November",
    "the deadline moved",
    "I have to call the bank",
    "remind me to email Ece",
    "Kira sözleşmesini göndermem lazım",
    "teslim cuma",
    "Son tarih 10 Kasım",
  ])
    assert.ok(hasCommitmentCue(yes), yes);
  for (const no of ["What is a closure in JavaScript?", "translate this into French", "written by a friend"])
    assert.ok(!hasCommitmentCue(no), no);
});

test("what is sent: the last 30 days, a cue in the person's own words, newest first, capped", () => {
  const all = readExport(claude).conversations;
  const s = selectConversations(all, { today: TODAY });
  assert.deepEqual(
    s.chosen.map((c) => c.id),
    ["c5-kira", "c3-tax", "c1-pantry", "c6-grant"],
  );
  assert.equal(s.tooOld, 1, "the August trip is older than 30 days");
  assert.equal(s.noCue, 1, "the closures question: only the assistant said 'need to'");
  assert.equal(s.overCap, 0);
  const capped = selectConversations(all, { today: TODAY, max: 2 });
  assert.deepEqual(
    capped.chosen.map((c) => c.id),
    ["c5-kira", "c3-tax"],
  );
  assert.equal(capped.overCap, 2);
  assert.equal(EXPORT_DAYS, 30);
  assert.equal(MAX_EXPORT_CONVERSATIONS, 50);
});

test("a conversation's text: labelled turns, redacted, the newest part kept when it is long", () => {
  const tax = fromClaudeExport(claude).find((c) => c.id === "c3-tax");
  const t = conversationText(tax);
  assert.match(t.text, /^One conversation with their assistant, "Tax form questions", last on 2026-11-01\./);
  assert.match(t.text, /\nUser: Remind me what goes in the tax form/);
  assert.match(t.text, /\nAssistant: List your income/);
  assert.ok(!t.text.includes("supersecretvalue99"));
  assert.equal(t.redactions, 1);
  const long = {
    id: "long",
    title: "Long",
    updated: "2026-11-02T10:00:00Z",
    turns: [
      { role: "user", text: `OLD ${"a".repeat(MAX_PASTE_CHARS)}` },
      { role: "user", text: "NEWEST: ship it by 2026-11-20" },
    ],
  };
  const cut = conversationText(long);
  assert.equal(cut.cut, true);
  assert.ok(cut.text.length <= MAX_PASTE_CHARS);
  assert.match(cut.text, /NEWEST: ship it by 2026-11-20$/);
  assert.match(cut.text, /^One conversation with their assistant/, "the header survives the cut");
});

const reply = (title, next = "none") =>
  JSON.stringify([
    {
      kind: next === "none" ? "fact" : "todo",
      topic: "Life",
      title,
      context: "Said in a chat.",
      result: "Noted.",
      next,
    },
  ]);

test("importExport: one call per conversation, dated by the conversation, cached for the next run", async () => {
  const { conversations } = readExport(claude);
  const chosen = selectConversations(conversations, { today: TODAY }).chosen;
  const calls = [];
  const saved = [];
  const complete = async (messages, opts) => {
    const user = messages.at(-1).content;
    calls.push({ user, opts });
    if (user.includes("Pantry")) return reply("Ship the Pantry beta", "Ship it, due 2026-11-20");
    if (user.includes("tax form")) return reply("Fill in the tax form", "Send it, due 2026-11-15");
    return reply("Something else");
  };
  const r = await importExport(complete, chosen, {
    kind: "claude",
    onSaved: (cache) => saved.push(Object.keys(cache).length),
  });
  assert.equal(calls.length, 4);
  assert.equal(r.sent, 4);
  assert.equal(r.failed, 0);
  assert.match(calls[0].user, /^Today: 2026-11-02$/m, "today is the conversation's own date");
  assert.equal(calls[0].opts.reasoningEffort, "low");
  assert.ok(!calls.some((c) => c.user.includes("supersecretvalue99")), "redacted before it is sent");
  assert.deepEqual(saved, [1, 2, 3, 4], "saved after each conversation, so a stopped run resumes");
  const entries = exportEntries(r.cache, conversations);
  const pantry = entries.find((e) => e.title === "Ship the Pantry beta");
  assert.equal(pantry.date, "2026-10-30", "dated by its conversation");
  assert.equal(pantry.source, "export");
  assert.equal(pantry.evidence, 'Claude conversation "Pantry launch plan", 2026-10-30');
  assert.equal(entries.length, 4);

  const again = await importExport(complete, chosen, { kind: "claude", cache: r.cache });
  assert.equal(calls.length, 4, "the same file again sends nothing");
  assert.equal(again.sent, 0);
  assert.equal(exportEntries(again.cache, conversations).length, 4, "and keeps what it read");

  const changed = chosen.map((c) => (c.id === "c3-tax" ? { ...c, updated: "2026-11-02T08:00:00.000Z" } : c));
  await importExport(complete, changed, { kind: "claude", cache: r.cache });
  assert.equal(calls.length, 5, "a conversation that changed is read again");
});

test("importExport: a failed conversation is counted, left out of the cache and asked again next time", async () => {
  const { conversations } = readExport(gemini);
  const chosen = selectConversations(conversations, { today: TODAY }).chosen;
  assert.deepEqual(
    chosen.map((c) => c.id),
    ["abc123"],
  );
  let fail = true;
  const complete = async () => {
    if (fail) throw new Error("model call failed: HTTP 500");
    return reply("Finish the grant report", "Finish it, due 2026-11-12");
  };
  const r = await importExport(complete, chosen, { kind: "gemini" });
  assert.equal(r.failed, 1);
  assert.deepEqual(r.errors, ["model call failed: HTTP 500"]);
  assert.deepEqual(r.cache, {});
  fail = false;
  const ok = await importExport(complete, chosen, { kind: "gemini", cache: r.cache });
  assert.equal(ok.sent, 1);
  const [e] = exportEntries(ok.cache, conversations);
  assert.equal(
    e.evidence,
    'Gemini conversation "I need to finish the grant report by 2026-11-12, can you outline it?", 2026-11-01',
  );
});

test("exportEntries keeps what was read from conversations still in the file, and only those", () => {
  const cache = {
    a: { stamp: "x", entries: [{ title: "From a" }] },
    gone: { stamp: "y", entries: [{ title: "From a deleted chat" }] },
  };
  assert.deepEqual(exportEntries(cache, [{ id: "a" }]), [{ title: "From a" }]);
});

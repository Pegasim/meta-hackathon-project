import test from "node:test";
import assert from "node:assert/strict";
import { githubLookup, parseRepos, refsIn, closedRefs, GITHUB_API, CACHE_MS } from "../../../src/agent/github.js";
import { readTools } from "../../../src/agent/tools.js";
import { planFor, stuckStep, nextAfter } from "../../../src/agent/moments.js";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-11-04T12:00:00Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();

// An invented repository: PR 12 open, PR 41 merged, PR 7 closed unmerged, issue 6 open,
// issue 3 closed. Records each path asked for.
const ISSUES = {
  12: { number: 12, title: "Add the cart badge", state: "open", created_at: ago(1), pull_request: { merged_at: null } },
  41: {
    number: 41,
    title: "Fix the checkout total",
    state: "closed",
    created_at: ago(5),
    closed_at: ago(2),
    pull_request: { merged_at: ago(2) },
  },
  7: {
    number: 7,
    title: "Try a new font",
    state: "closed",
    created_at: ago(9),
    closed_at: ago(3),
    pull_request: { merged_at: null },
  },
  6: { number: 6, title: "Search is slow on mobile", state: "open", created_at: ago(4) },
  3: { number: 3, title: "Typo on the about page", state: "closed", created_at: ago(20), closed_at: ago(10) },
};
function fakeGitHub({ status = 200, fail = false } = {}) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url.replace(GITHUB_API, ""));
    if (fail) throw new TypeError("Failed to fetch");
    const path = url.replace(GITHUB_API, "");
    const reply = (body, s = status) => ({ ok: s >= 200 && s < 300, status: s, json: async () => body });
    if (status !== 200) return reply({ message: "API rate limit exceeded" });
    const one = path.match(/^\/repos\/acme\/shop\/issues\/(\d+)$/);
    if (one) return ISSUES[one[1]] ? reply(ISSUES[one[1]]) : reply({ message: "Not Found" }, 404);
    if (/\/pulls\?state=open/.test(path)) return reply([ISSUES[12]]);
    if (/\/pulls\?state=closed/.test(path))
      return reply([
        { ...ISSUES[41], merged_at: ago(2) },
        { ...ISSUES[7], merged_at: null },
        { number: 2, title: "Old merge", merged_at: ago(30) },
      ]);
    if (/\/issues\?state=open/.test(path)) return reply([ISSUES[12], ISSUES[6]]);
    return reply({ message: "Not Found" }, 404);
  };
  return { fetch, asked };
}
const lookup = (opts = {}) => {
  const gh = fakeGitHub(opts);
  return { ...gh, github: githubLookup({ repos: ["acme/shop"], fetch: gh.fetch, now: () => NOW }) };
};

test("the tool tells an open, a merged and a closed PR, and an issue, apart", async () => {
  const { github } = lookup();
  const tool = readTools({ github }).github_status;
  const r = await tool.run({ numbers: [12, 41, 7, 6] }, {});
  assert.deepEqual(
    r.items.map((i) => [i.number, i.kind, i.state, i.since]),
    [
      [12, "pr", "open", ago(1).slice(0, 10)],
      [41, "pr", "merged", ago(2).slice(0, 10)],
      [7, "pr", "closed", ago(3).slice(0, 10)],
      [6, "issue", "open", ago(4).slice(0, 10)],
    ],
  );
  assert.equal(tool.summary(r), "#12 open, #41 merged, #7 closed, #6 open");
  // Only names, numbers, states and titles come back.
  assert.deepEqual(Object.keys(r.items[0]).sort(), ["kind", "number", "repo", "since", "state", "title"]);
});

test("without numbers the tool lists open PRs, PRs merged in 7 days and open issues, titles only", async () => {
  const { github } = lookup();
  const tool = readTools({ github }).github_status;
  const ctx = {};
  const r = await tool.run({ repo: "acme/shop" }, ctx);
  assert.deepEqual(r.open_prs, [{ number: 12, title: "Add the cart badge" }]);
  assert.deepEqual(r.merged_last_7_days, [{ number: 41, title: "Fix the checkout total" }]);
  assert.deepEqual(r.open_issues, [{ number: 6, title: "Search is slow on mobile" }], "a PR is not an issue");
  assert.equal(tool.summary(r), "1 open PR, 1 merged, 1 open issue");
  assert.equal(ctx.github.length, 3, "what was read is kept, so a step may name it");
});

test("a rate-limit reply is 'could not check', and GitHub is not asked again for a while", async () => {
  for (const status of [403, 429]) {
    const { github, asked } = lookup({ status });
    const tool = readTools({ github }).github_status;
    const r = await tool.run({ numbers: [41] }, {});
    assert.equal(r.items[0].state, "unknown");
    assert.equal(tool.summary(r), "#41 could not check");
    assert.equal((await tool.run({}, {})).error, "could not check");
    assert.equal(asked.length, 1, `after a ${status}, nothing more is asked`);
  }
});

test("answers are cached for a few minutes", async () => {
  let now = NOW;
  const gh = fakeGitHub();
  const github = githubLookup({ repos: ["acme/shop"], fetch: gh.fetch, now: () => now });
  await Promise.all([github.state("acme/shop", 41), github.state("acme/shop", 41)]);
  await github.state("acme/shop", 41);
  assert.equal(gh.asked.length, 1, "two asks at once, and one later, make one request");
  now += CACHE_MS + 1;
  await github.state("acme/shop", 41);
  assert.equal(gh.asked.length, 2);
});

test("with no repository listed there is no GitHub tool", () => {
  assert.equal(readTools({ github: null }).github_status, undefined);
  assert.equal(readTools({ github: githubLookup({ repos: [] }) }).github_status, undefined);
  assert.ok(readTools({}).recall_notes, "the other tools stay");
});

test("with several repositories the tool needs one named", async () => {
  const gh = fakeGitHub();
  const github = githubLookup({ repos: ["acme/shop", "acme/site"], fetch: gh.fetch, now: () => NOW });
  const tool = readTools({ github }).github_status;
  assert.deepEqual(tool.parameters.properties.repo.enum, ["acme/shop", "acme/site"]);
  await assert.rejects(tool.run({ numbers: [41] }, {}), /name the repository/);
  assert.equal((await tool.run({ repo: "acme/shop", numbers: [41] }, {})).items[0].state, "merged");
});

test("Settings' list: owner/name or a github.com address, once each; anything else is named", () => {
  assert.deepEqual(parseRepos("acme/shop\n https://github.com/acme/site.git \nACME/shop\n\nnot a repo"), {
    repos: ["acme/shop", "acme/site"],
    bad: ["not a repo"],
  });
});

test("references: owner/name#N for a listed repository; #N, PR N and issue N when only one is listed", () => {
  const one = ["acme/shop"];
  assert.deepEqual(refsIn("Review PR #41, then PR 12, issue 6 and #3", one), [
    { repo: "acme/shop", number: 41 },
    { repo: "acme/shop", number: 12 },
    { repo: "acme/shop", number: 6 },
    { repo: "acme/shop", number: 3 },
  ]);
  assert.deepEqual(refsIn("Close ACME/shop#7", one), [{ repo: "acme/shop", number: 7 }]);
  assert.deepEqual(refsIn("Review other/lib#41", one), [], "an unlisted repository is not asked about");
  assert.deepEqual(refsIn("Write 3 tests", one), []);
  const two = ["acme/shop", "acme/site"];
  assert.deepEqual(refsIn("Review PR #41", two), [], "with several, a bare number names none");
  assert.deepEqual(refsIn("Review acme/site#41", two), [{ repo: "acme/site", number: 41 }]);
});

test("the check finds the merged and closed ones, and a failed lookup finds none", async () => {
  const texts = ["Review PR #41", "Finish PR #12", "Fix issue 3", "Review other/lib#41", "Write the tests"];
  const closed = await closedRefs(lookup().github, texts);
  assert.deepEqual(
    [...closed],
    [
      [0, { ref: "acme/shop#41", state: "merged" }],
      [2, { ref: "acme/shop#3", state: "closed" }],
    ],
  );
  assert.equal((await closedRefs(lookup({ fail: true }).github, texts)).size, 0);
  assert.equal((await closedRefs(lookup({ status: 429 }).github, texts)).size, 0);
  assert.equal((await closedRefs(null, texts)).size, 0);
});

// ---- The check before a step is shown ---------------------------------------

function scripted(...replies) {
  let n = 0;
  return async () => ({
    role: "assistant",
    content: null,
    tool_calls: (replies[n++] ?? []).map(([name, args], i) => ({
      id: `c${n}-${i}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args ?? {}) },
    })),
  });
}
const notes = [
  { title: "Shop release", topic: "shop", text: "Review PR #41 and PR #12, close issue 6 before the release." },
];
const deps = (github) => ({
  recall: async () => notes,
  tasks: async () => [{ id: "t1", title: "Review PR #41", when: "today" }],
  activity: async () => [],
  page: async () => ({ skipped: "settings" }),
  goal: async () => ({ title: "Ship the shop release" }),
  github,
});
const planOf = (...steps) => [
  ["recall_notes", { query: "shop release" }],
  ["make_plan", { steps: steps.map((step) => ({ step, minutes: 15 })) }],
];
const planWith = (steps, github) =>
  planFor(scripted(...planOf(...steps).map((c) => [c])), deps(github), { title: "Ship the shop release" });

test("a plan step naming a merged PR is left out, an open one is kept, and the trail says so", async () => {
  const r = await planWith(
    ["Review PR #41 for the shop release", "Review PR #12 for the shop release", "Close issue 6 for the release"],
    lookup().github,
  );
  assert.deepEqual(
    r.value.steps.map((s) => s.step),
    ["Review PR #12 for the shop release", "Close issue 6 for the release"],
  );
  assert.deepEqual(r.trail.at(-1), { tool: "github_check", args: { ref: "acme/shop#41" }, result: "merged, left out" });
});

test("a step naming an unlisted repository is kept, and a failed lookup drops nothing", async () => {
  const steps = [
    "Review other/lib#41 for the shop release",
    "Review PR #41 for the shop release",
    "Close issue 6 for the release",
  ];
  const kept = await planWith(steps, lookup({ fail: true }).github);
  assert.equal(kept.value.steps.length, 3);
  assert.ok(!kept.trail.some((t) => t.tool === "github_check"));
  const checked = await planWith(steps, lookup().github);
  assert.deepEqual(
    checked.value.steps.map((s) => s.step),
    ["Review other/lib#41 for the shop release", "Close issue 6 for the release"],
  );
});

test("with no repository listed, nothing is looked up and the plan is as the model made it", async () => {
  const r = await planWith(
    ["Review PR #41 for the shop release", "Review PR #12 for the shop release", "Close issue 6 for the release"],
    null,
  );
  assert.equal(r.value.steps.length, 3);
});

test("every plan step left out is no plan", async () => {
  const r = await planWith(
    ["Review PR #41 for the shop release", "Close issue 3 for the release", "Close PR 7 for the release"],
    lookup().github,
  );
  assert.equal(r.value, null);
  assert.equal(r.source, "agent");
  assert.equal(r.trail.filter((t) => t.tool === "github_check").length, 3);
});

test("a stuck step naming a merged PR is left out, so the template answers", async () => {
  const chat = scripted(
    [["recall_notes", { query: "shop" }]],
    [["propose_step", { step: "Review PR #41 for the shop release" }]],
  );
  const r = await stuckStep(chat, deps(lookup().github), { title: "Ship the shop release" });
  assert.equal(r.value, null);
  assert.equal(r.trail.at(-1).result, "merged, left out");
});

test("a next line offering a task that names a merged PR offers no task", async () => {
  const chat = scripted(
    [["list_tasks"]],
    [["suggest_next", { message: "Nice work. On to the next thing?", task_id: "t1" }]],
  );
  const r = await nextAfter(chat, deps(lookup().github), { title: "Ship the shop release" });
  assert.equal(r.value.message, "Nice work. On to the next thing?");
  assert.equal(r.value.task, null);
});

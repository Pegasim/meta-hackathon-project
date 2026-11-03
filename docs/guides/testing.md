# Testing

A change is done when the tier its test plan names is green, and the output is
in the report. Tests protect code that changes; checks (`checks/`) constrain
what may be written. This file is about tests.

## Tiers

| Tier | What it proves | Command | Runs |
|---|---|---|---|
| unit | One module's behavior, offline, fake model and injected clock: `src/memory/`, `src/attention/`, `src/agent/`, `src/tuck/` (in `test/unit/`, mirroring `src/`) | `npm test` | every change |
| unit — replay | The attention engine replays a recorded event log and produces the expected triggers (no unfair warnings, drift caught) | `npm test` | every change |
| integration | The real extension in real Chromium (Playwright) with a fake model: service worker, overlay, side panel, "Take me back" | `npm run test:browser && npm run test:e2e` | when `src/background/`, `src/tuck/`, `src/popup/` or `src/options/` change, and before a PR |
| live | Real calls to Meta's Model API with `MODEL_API_KEY` from `.env` | `node --env-file=.env test/live/model.mjs` | only when the human asks |
| eval | Relevance accuracy (LLM#1) on labelled cases against a baseline | `npm run eval` | when a prompt or the model changes |
| live smoke | The whole product in the user's real Chrome | `test/live_smoke.md` | only when a human arms it |

`npm test` runs only `test/unit/**/*.test.js`. Integration tests live in `test/browser/`
and live tests in `test/live/`, so the default command skips them. A test that
needs a secret or the network is never in the unit tier.

The API key lives in `.env` at the repo root (`MODEL_API_KEY=...`). It is
gitignored and the agent may not read it; scripts load it with
`node --env-file=.env`.

## Rules

1. **A bug starts with a failing test.** Write it, watch it fail for the
   reason the bug describes, then fix the code.
2. **Never weaken a test to make it pass.** Deleting an assert, loosening an
   expected value, or adding `skip`/`.only` is a decision, not a fix.
   If a test is wrong, say so in the report and leave the change to a human.
   This is the code version of reward hacking: green without the behavior.
3. **Test behavior through the public seam,** not private helpers — the
   attention engine through its events in and triggers out. A refactor that
   keeps behavior should not break a test.
4. **Fixtures come from reality.** Event logs recorded from real browsing in
   `test/fixtures/`, the demo log in `demo/eventlog.json`, the cases in
   `evals/relevance/cases.jsonl`. A hand-written log is allowed only for an edge case
   real browsing cannot produce on demand (e.g. a service worker restart
   mid-drift), and says so in a comment.
5. **Mock only what you do not own,** and only at the boundary: the Meta model
   API (a fake `complete()` returning fixed JSON), the clock (`now` injected),
   and Chrome APIs. Never mock `src/attention/`, `src/agent/` or `src/memory/`.
6. **Pin both directions of a contract.** "Unsure → neutral" and "related →
   never warns" each have a test, and so do "unrelated past tolerance → drift"
   and "neutral → budget unchanged", so neither side drifts.
7. **One test per success criterion** in `docs/INTENT.md` that code can check. A
   criterion with no test is listed under "Not checked yet".
8. **A flaky test is a bug.** Quarantine it with an issue link; never retry
   it until it passes. Model variance belongs in the eval (several runs
   against a baseline), not in tests.

## Live smoke

`test/live_smoke.md` is a checklist a human arms, not an automated test. It
lists the preconditions, the budget, the steps, and what is recorded. The
agent never runs it on its own initiative.

## Not checked yet

- **No unfair warnings / drift is caught** — `test/unit/attention/criteria.test.js` checks
  both on every `test/fixtures/<name>.log.json` + `<name>.labels.json`. One recording so
  far (`2026-11-03-avatar`, 15 minutes, one person, two drifts); more are needed before
  the rates mean much.
- **Intervention speed** — threshold open in `docs/INTENT.md`; an e2e timing test
  comes once the threshold is set.
- **Demo flow works** — `test:e2e` covers the engine flow (goal → drift → nudge →
  Take me back → This is for my task → log); the full demo script needs plan 2's
  overlay and side panel.
- **It actually helps** — threshold open; computed from the user's own event
  log, not a test.

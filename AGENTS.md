# Agent Instructions

## Project

A Chromium MV3 extension: a focus companion for people with ADHD and anyone whose attention
drifts easily. It knows what you meant to do today, notices when you drift away from it in the
browser, and talks you back through a small avatar — a buddy, not a blocker — learning which
detours are fine for you. Apart from a coding agent's status (`bridge/`, optional, status only) it
does not monitor outside the browser. It does not block or lock pages, or give
medical advice. It judges pages by URL and title, and notes which conversation you are working in
by its heading; only right before a drift nudge does it check whether you are typing and read a
short, redacted excerpt of the page (settings; never kept).

**Stack:** JavaScript (plain ES modules, no build step), Chrome MV3, IndexedDB + `chrome.storage`, Meta Model API (OpenAI-compatible); Node 24 + npm for tests
**Layout:** `src/` is the extension (Load unpacked → `src/`): `background/` service worker ·
`attention/` deterministic engine, no Chrome dependency · `agent/` LLM nodes, structured
output; at a goal set, a goal done and "I'm stuck", a tool loop (`loop.js`, #81) · `tuck/` Tuck on the page · `popup/`, `options/`, `shared/` ·
`memory/` Safa's, used through the `Memory` API. `test/unit/` mirrors `src/` · `evals/` JS eval ·
`docs/` intent, decisions, design, guides, specs

## Commands

| Task | Command |
|---|---|
| install | `npm install && npx playwright install chromium` |
| run locally | `chrome://extensions` → Developer mode → Load unpacked → `src/` |
| connect Muse Code | `node bridge/install.mjs <project folder>` (macOS) |
| test — all | `npm test` |
| test — one | `node --test test/unit/<area>/<name>.test.js` |
| test — integration | `npm run test:browser && npm run test:e2e` |
| test — live | `node --env-file=.env test/live/model.mjs` (real API; only when asked) |
| eval | `npm run eval` (relevance, real API; `REPS=1` for a quick run) |
| eval — tasks | `npm run eval:tasks` (to-do list node, real API; `REPS=1` for a quick run) |
| replay — tasks | `node scripts/replay-tasks.mjs <brain folder> [verdicts.json] [--today YYYY-MM-DD]` (Settings' task views over a brain folder; counts only) |
| format | `npx prettier --write <file>` (no lint; never reformat untouched files) |
| typecheck | none (plain JS) |

Never invent an invocation. If a command is missing here, ask for it, then add it.

## Rules

1. **Both errors count: false warnings and missed drifts.** A nagging buddy gets uninstalled; one
   that misses most distractions is useless. Every nudge offers a one-click correction, both
   rates are measured by replay, and feedback tunes them. <!-- enforced by: nothing yet (replay test) -->
2. **`src/memory/` is Safa's.** If our code needs a change there, open a GitHub issue for Safa
   instead of editing it directly.
3. **Small diffs.** Do not rewrite, reorganize, or reformat code the task did not require.
4. **No new files as a side effect.** No extra README, summary, or report unless asked.
5. **The person's notes never reach Contributor.** Meta may train on what
   `muse-spark-1.3-contributor` is sent. Settings no longer offer it, but settings saved
   earlier can still name it. Any model call
   carrying memory content goes through `privateSettings()` from `src/agent/relevance.js`.
   <!-- enforced by: nothing yet (test/unit/agent/relevance.test.js covers the helper only) -->

## Workflow

- Read `docs/INTENT.md` before a change that touches what the product does. If the
  change conflicts with it, say so before writing code.
- Non-trivial change: follow `docs/guides/workflow.md`. Plan first (`/plan`),
  agree on it, then implement.
- Read the guide for an area before changing it; update that guide when behavior changes.
- State assumptions when a requirement has two readings. Push back when a simpler
  design or an existing pattern solves it better.
- Style is the linter's job. Run the lint command; do not hand-police formatting.
- The worktree may hold human edits. Inspect current content before editing and
  preserve unrelated changes.
- Before reporting a change done, run the test and lint commands above and reach
  green; if a check fails or can't run, say so instead of reporting done.
- Testing follows `.agents/skills/test/SKILL.md`: which tier a change needs, and
  never weakening a test to pass.
- Before opening a PR, run `/code-review` at the level the change warrants.

## Reporting

Say only what you verified, and name the evidence — command, exit status, test count, SHA.
`written` → `tests pass` → `merged` → `deployed` are separate claims; none implies the next.
If a check was skipped or failed, say so plainly. Your own second pass is not verification.

## Git

Conventional Commits (`feat(scope): …`, `fix(scope): …`, `docs: …`). No trailers, ever —
no `Co-Authored-By`. Commits before Nov 1 2026 use plain sentences; leave them as they are.
Never push unless asked, every time.

- **Protected branches:** `main`. Branch first; never commit ordinary work there.
- **Commit body width:** 72
- **Before committing:** `pre-commit install` once (gitleaks)

Full procedure: `.agents/skills/commit/SKILL.md`.

## Where to look

| For | Read |
|---|---|
| what the product is for and what "working" means | `docs/INTENT.md` |
| how a change goes from idea to merged PR | `docs/guides/workflow.md` |
| what was decided or rejected, and why | `docs/DECISIONS.md` |
| test tiers, fixtures, what may be mocked | `docs/guides/testing.md` |
| visual identity and banned UI patterns — read before any UI work | `docs/DESIGN.md` |
| the MVP design: attention, agent, UI | `docs/superpowers/specs/2026-10-31-attention-agent-design.md` |
| plans, open and done | `docs/plans/` |

Directory-scoped rules live in `<dir>/AGENTS.md` and apply to everything under it.

# Focus Companion — Attention, Agent and UI Design (MVP)

Date: 2026-10-31 · Paths updated to the 2026-11-01 layout (`src/` is the extension; see §13) · Owner: İrem (`src/attention/`, `src/agent/`, `src/background/`, `src/tuck/`, `src/popup/`, `src/options/`) · Memory: Safa (`src/memory/`)
Deadline: **Nov 4 2026, 9:00 PM ET** (Meta Global AI Developer Hackathon, Indie track). Judged on the **demo video + repo**.

## 1. Intent and why

A **buddy** for people with ADHD and anyone whose attention drifts easily: it watches what you do in the browser, notices when you lose your goal, and talks you back. Not a tool that punishes or blocks; a friend sitting next to you who knows what you meant to do.

The user's own experience (İrem): mid-task she slides into Spotify, YouTube, email. Short detours are fine; the problem is staying long without noticing, or hopping between tabs constantly. Wanted: after ~30 s – 1 min somewhere unrelated, the companion steps in, reminds her of the goal, asks for a status, says "this is where you left off".

"Unrelated" is decided **against the current goal, not a fixed blocklist** (email is sometimes part of the work; a tutorial on YouTube can be work). The system personalises as it is used.

Judging criteria: creativity, technical ambition, whether it works. So: **the core attention engine must be reliable and demonstrable**; the technical story is "deterministic attention engine + LLM only where judgment is needed + personal learning".

## 2. Goals, non-goals, anti-goals

**Goals (MVP)**
- On session open, the avatar starts the conversation; based on unfinished work in memory it asks "continue or something new?" and forms a goal.
- Every page judged related / unrelated / neutral against the goal.
- Drift detected at ~45 s, and rapid tab hopping (fragmentation) detected.
- Graduated intervention that never locks the page; one click "Take me back" to the last related tab.
- Learning from feedback ("This is for my task" → durable label; personal tolerance).
- Modes: Focus / Gentle / Do Not Disturb / Off.
- Every event written to a raw event log; metrics computed from it; record-and-replay testing.
- An end-to-end flow that works in the demo video.

**Non-goals (not in this MVP)**
- System-wide (outside the browser) monitoring, a desktop app.
- Connecting to Safa's MCP server (decided: memory works by folder import; MCP later, once latency is measured).
- Muse Code / claude.ai/code session connection (next stage).
- Using raw transcripts (cold layer).
- Chrome Web Store publication (an optional "unlisted" submission is a bonus if time allows).
- Extensions such as web search, MCP tools, quick actions.
- Screenshots. Page content only through the second look before a drift word (§10, issue #5).

**Anti-goals (failure even if it technically works)**
- A nagging companion: unfair warnings during research, repeating itself.
- A blind companion: missing most real distractions. Both errors are measured (replay) and corrected through feedback.
- Intervention that blocks the page, opens a modal, or cannot be dismissed.
- Moralising, medical or mental-health advice, diagnostic language.
- A demo flow that stalls (LLM latency must never show up as the user waiting).

## 3. Constraints

- **Time:** ~4 days. Every decision is weighed by "will this work solidly in the demo within 4 days?". No over-engineering; each step is built by trying and checked by eye.
- **Platform:** Chromium MV3 extension, all JavaScript. No separate backend; model calls go straight from the extension.
- **Build:** The repo is plain ES modules with no build step. That stays; the only exception is an esbuild bundle for the agent if the LangGraph trial passes (§6.3).
- **Model:** `muse-spark-1.3-contributor` (repo default, OpenAI-compatible, via `src/memory/model.js`). If not reachable from Turkey, `muse-spark-1.3`. No Muse Wonder. Budget: $150 API credit.
- **Memory boundary:** `memory/` is Safa's. Not modified; only the `Memory` API (src/memory/README.md) is used. Small API additions, if ever needed, are requested from Safa.
- **Privacy:** URL, title and tab signals; before a drift word about a page, a second look: typing (yes/no) and a short redacted excerpt, never kept (§10). No screenshots. (Until 2026-11-01: URL + title only, as a hypothesis; it failed on mixed sites, issue #5.)
- **Language:** Code, comments, docs, prompts, template messages, UI text and the demo video are **English**. The companion's voice is minimal and friendly ("Take me back", "Give me 5" — not corporate, not robotic). If the user writes in another language, it answers in that language.
- **Demo data:** No real brain. The repo ships a fake brain folder for the demo (`demo/brain/`, in brain format; unfinished work and a few notes) and a sample event log (`demo/eventlog.json`). Loaded via brain import and an "import event log" button on the options page; replay tests use the same log. The video can be re-recorded identically from this data.

## 4. Decided (İrem and the team)

- Chromium extension (not system-wide).
- Two-layer memory: **hot** (in-extension IndexedDB: activity, events, labels, notes imported from the brain) and **cold/durable** (Safa's second brain; folder import for now). No MCP for now.
- Attention, agent and UI/UX are İrem's; `agent/audit.js (removed 2026-11-01)` is not the basis.
- Deterministic / factual work runs as scripts; the LLM only where judgment is needed, with **structured output**. The agent makes **no tool calls**: the model returns an intent/action, a script executes it.
- The avatar companion starts the conversation; chat interface + modes + feedback live in the UI.
- Logging: raw data, recorded correctly, sufficient to understand the person's browsing flow.
- The first attention engine design (v1) is accepted; it will be iterated by trying it.

## 5. Architecture

### 5.1 Folders

```
memory/       Safa — untouched. Memory API (entries, intent, open loops, contextPack, recordActivity, brain import)
attention/    İrem — plain JS, no Chrome dependency, tested with node
              sensor event model, relevance (label/cache/LLM gate), budget, state machine, triggers, policy, eventlog, metrics
agent/        İrem — LLM nodes (structured output), dialogue flows, schemas, prompt formatting
              audit.js stays as reference, not wired
extension/    İrem — Chrome glue: background.js (rewritten), sidepanel/, overlay/ (content script), options/
evals/        İrem — simple JS eval for LLM nodes (cases, graders, baseline); replaces the Python harness
demo/         fake brain + sample event log
test/         node unit tests + replay tests + live model tests
```

### 5.2 Flow

```
chrome.tabs/windows/idle/alarms ─► sensor ─► context event ─► relevance ─► budget + state machine ─► trigger
                                                   │  (label → cache → LLM#1)                         │
                                                   ▼                                                  ▼
                                               eventlog ◄──────────────────────────────────────── policy (mode, cooldown, level)
                                                                                                      │
                                         agent (LLM#2–#4, structured) ◄── only when it must speak ────┘
                                                   │
                                                   ▼
                                     UI: avatar overlay + bubble + buttons / side panel chat
                                                   │
                         user reply ─► button: direct script action │ free text: LLM#3 → action → script
```

Attention is "the senses and the reflex": it runs every second and is deterministic. The agent is "the voice and the mind": it runs only when it has to speak or judge.

### 5.3 Script vs LLM

**Script (deterministic):** sensors, dwell time, drift budget, tab-switch rate, state machine, triggers, cooldown, modes, label/cache lookup, switching back to a tab, button actions, logging, metrics, session-start detection.

**LLM (judgment):** only the five nodes in §6.2.

## 6. Components

### 6.1 Attention engine (`attention/`)

**Sensor (inside src/background/index.js, feeds events to attention)**
- `tabs.onActivated`, `tabs.onUpdated` (url/title/status complete), `windows.onFocusChanged`, `idle.onStateChanged`, `chrome.alarms` 30 s heartbeat.
- Snapshot: `{ts, tabId, windowId, url, host, title, audible, browserFocused, idleState}`.
- No input on an audible tab is not "away" (the repo's current behaviour is kept).
- The extension's own pages are neutral.
- The service worker can be stopped: all engine state (`state`, `budget`, `currentContext`, `lastRelevant`, `cooldowns`) is written to `chrome.storage.session` and read back on every event. In-memory state is never the source of truth.

**Relevance**
- Key: `intentId + host + normalize(title)` (on sites like YouTube the title is essential; on most sites the host may be enough — the builder decides normalisation).
- Order: (1) user labels (2) cache (3) LLM#1. While the LLM answer is pending, the page counts as **neutral**.
- Result: `related | unrelated | neutral` + `confidence`. A low-confidence `unrelated` (threshold is the builder's, start at 0.6) is **unsure**: it never escalates past L1 (the avatar only looks, no text, no LLM), so the user can react without being nagged. Both errors count (docs/INTENT.md): unsure pages are neither silent nor nagging.
- Neutral covers in-between stops: search engines, new tab, calendar, the extension itself.

**Drift budget**
- Every second in an unrelated context adds to the budget; in a related context the budget decays; neutral holds it steady.
- Budget over the tolerance threshold → `drift` trigger.
- Tab switches in the last 2 min and their unrelated share are also tracked → `fragmentation` trigger. Off by default since 2026-11-02 (#30); only confident unrelated time counts.
- Starting values (the builder tunes them, verified by replay): tolerance ~45 s; decay ~2× the rate of unrelated accumulation; fragmentation: ≥6 switches in 2 min with ≥50% of the time unrelated.

**State machine**
`focused` · `detour` (unrelated, budget under threshold) · `drifting` · `away` (idle / browser unfocused / screen locked) · `break` (declared by the user, timed) · `paused` (Do Not Disturb / Off) · `no_intent`.

**Last related place:** the `{tabId, url, title, ts}` of the last `related` context is always kept. If that tab was closed, the URL opens in a new tab.

**Triggers**
| Trigger | Condition |
|---|---|
| `session_start` | First active browser focus of the day, or the extension was enabled, and there is no active goal |
| `drift` | Budget over tolerance |
| `fragmentation` | The condition in "Drift budget" |
| `return` | `away` → active after being away ≥ a few minutes (builder: ~5 min) |
| `break_over` | The declared break has ended |
| `checkin` | Long uninterrupted focus (builder: ~25 min) — light, optional |

**Policy (deterministic)**
- Modes: Focus = all triggers; Gentle = tolerances ~2×, levels L1–L2 only; Do Not Disturb = sensors and log keep running, no intervention (triggers logged with `suppressedBy: "dnd"`); Off = sensors stop too.
- Levels: **L1** avatar attention animation, no text, no LLM → **L2** bubble: short question + buttons (*Take me back*, *This is for my task*, *5-min break*) → **L3** goal + "you were last doing this" + *Take me back*. If the user does not react and the drift continues, the next level follows.
- Cooldown per trigger type (builder: ~2 min after L2). Suppressed triggers are logged too.
- Intervention never locks the page; the avatar can be minimised.

**Learning (deterministic)**
- *This is for my task* → label `{host(+title pattern), intentTopic, label: related}` in the hot layer; plus a record in memory via `memory.add({kind: "preference", ...})` (exportable to the brain).
- Personal tolerance, per host: if the user often comes back on their own before an intervention, tolerance grows; if they ignore interventions and stay long, it shrinks (simple exponential average; bounds 20–120 s).

### 6.2 Agent (`agent/`)

Five LLM nodes. Each returns structured output against a JSON schema; if schema validation fails it is asked once more with the error text, then falls back deterministically.

| # | Node | When | Input (formatted from raw state) | Output | Fallback |
|---|---|---|---|---|---|
| 1 | `classifyRelevance` | A new context not in labels/cache | goal, steps, host, title, examples of user labels | `{label, confidence, reason}` | `neutral` |
| 2 | `openSession` | `session_start` dialogue | open loops, last goal, user's reply | `{message, intent?: {title, steps[], estMin, topic}, continueLoopId?, needsMore: bool}` | template question |
| 3 | `interpretReply` | User typed free text | conversation history, attention snapshot | `{action: "label_relevant"\|"break"\|"new_intent"\|"complete_intent"\|"set_mode"\|"chat", args, reply}` | `chat` + template reply |
| 4 | `composeNudge` | L2/L3 intervention | trigger event, goal, last related place, personal patterns | `{message, buttons[]}` | template message (shown immediately; replaced if the LLM answers within ~2 s) |
| 5 | `reflect` | Hourly alarm and session end | summary computed from the event log | `{patterns[], suggestions[]}` → memory as `lesson`/`fact` | skip |

Persona rules (all nodes): short, warm, concrete; English by default, minimal and friendly; answer in the user's language if they write in another; no moralising, no medical language.

Reused from the repo: `src/memory/model.js` (`modelClient`), `extractJsonObject` from `agent/audit.js (removed 2026-11-01)` (copied), the scenarios in `test/live/audit.mjs (removed 2026-11-01; cases live in evals/relevance/cases.jsonl)` adapted as eval cases for LLM#1.

### 6.3 LangGraph.js decision (day-one trial)

The dialogue flows (2, 3, 4 and the "wait for the user's reply" between them) fit LangGraph's node + `interrupt()` model. But in the browser it only runs via `@langchain/langgraph/web` (needs a bundle), `MemorySaver` is lost when the service worker stops, and it is not officially verified in an MV3 service worker.

**Decision gate (at most ~2 hours):** if LangGraph.js `/web`, bundled with esbuild, can run a graph inside the extension (in the side panel context) and do `interrupt` → resume, it is used. If not, the same node/state design is implemented with plain functions and a simple state object. Node definitions, schemas and state design are identical either way. The attention engine never depends on LangGraph.

State principles (from LangGraph's "Thinking in LangGraph" guide): raw data in state; prompts formatted inside the node; transient errors retry with backoff, schema errors go back to the LLM, missing information is asked of the user.

### 6.4 Event log and metrics (`src/attention/store.js`)

An append-only `events` store, indexed by `ts` and `type`, in attention's own IndexedDB database (separate from memory's, to leave Safa's schema alone). Also `labels`, `relevanceCache`, `tolerance` and `intents` stores.

```
context    {ts, tabId, host, url, title, audible, browserFocused, idleState}
relevance  {ts, key, label, confidence, source: label|cache|llm|fallback, latencyMs, intentId}
state      {ts, from, to, budget, switches2m}
trigger    {ts, id, type, level, evidence, suppressedBy?}
response   {ts, triggerId, choice, latencyMs}
llm        {ts, node, model, inputTokens, outputTokens, latencyMs, ok, error?}
session    {ts, kind: start|end|intent_set|intent_done|mode, payload}
feedback   {ts, kind: label|tolerance|missed_drift, payload}
```

- Metrics (focus share, drift count, time to return, intervention acceptance rate, most-drifted sites, drift by hour) are **computed, not stored**.
- The log can be exported as JSON (button on the options page) — for debugging, replay and the demo.
- `memory.recordActivity` keeps being fed (so memory's `activity()` and `distill()` keep working).
- Retention: 7 days (same as memory).

### 6.5 Memory integration

| What | How |
|---|---|
| Unfinished work (session open) | `memory.openLoops()`, `memory.latestIntent()` |
| Setting / finishing a goal | `memory.setIntent()`, `memory.completeIntent()` (mirrored by the shadow intent, §9.1) |
| Context for relevance | `memory.contextPack({title, url})` (shortened for LLM#1) |
| Learned preferences and patterns | `memory.add({kind: "preference"\|"lesson", topic, ...})` |
| Tab activity | `memory.recordActivity()` (current behaviour) |
| Brain import / upkeep | the existing `maintain` and `syncBrain` alarms are kept |

Labels and tolerance live in the hot layer in attention's DB (fast, read every second); their durable counterparts are written to memory. An MCP adapter can later sit behind this table without changing the interface.

### 6.6 UI/UX (`src/` (background, tuck, popup, options))

- **Avatar overlay (content script, Shadow DOM):** injected into the active tab with `chrome.scripting`; small, in a page corner, draggable, minimisable. State animations: `idle`, `watching`, `curious` (L1), `talking` (L2/L3 bubble), `celebrating` (goal done / came back), `sleeping` (Do Not Disturb / break). SVG + CSS animation. On pages that cannot be injected (`chrome://`, Web Store) it falls back to the side panel + badge.
- **Bubble:** next to the avatar; message + up to 3 buttons + *Talk to me* (opens the side panel; see §9.3). Never modal.
- **Side panel (replaces the popup; opens on the extension icon):** active goal and steps at the top (*Done* button), mode selector (4 modes), chat history and input, today's summary (focus time, drift count, time to return — computed from the log).
- **"You missed one" button (side panel):** the user flags a drift the companion did not catch. It logs a `feedback {kind: "missed_drift", windowStart, windowEnd}` event covering the last few minutes (builder: ~5 min), which replay and tuning use as a labelled miss. The avatar answers warmly and offers the goal. Working label; the wording may change later.
- **Options page:** the existing model/key settings + brain folder connection (already in the repo) + export/import of the event log + reset.
- `chrome.notifications` only as a fallback, e.g. break over while the browser is unfocused.
- **The avatar's visual identity is not designed yet.** Inspired by the simplicity and cuteness of the Claude icon, but a different shape. The visual design happens in a separate session with mockups; meanwhile the builder uses a simple placeholder SVG character (with working state animations).

## 7. Build-by-trying order

Each step ends with something working that can be checked by eye:

1. **Sensor + event log + export.** An hour of real browsing; read the log. Fake brain (`demo/brain/`) prepared alongside.
2. **LLM#1 offline eval (`evals/`, JS):** a node script over recorded contexts and adapted scenarios; accuracy and latency table, compared with a stored baseline. Contributor access is verified here.
3. **Budget + state machine + triggers + policy,** tuned with replay tests over the recorded log.
4. **LangGraph decision gate** (§6.3), at most ~2 hours.
5. **Overlay avatar + bubble + buttons** (template messages first), "Take me back".
6. **Side panel:** goal, modes, chat; `openSession`, `interpretReply`, `composeNudge`.
7. **Learning:** labels, tolerance; `reflect`.
8. **Demo data (fake brain + sample event log) finalised + demo script + video.**

Tests: node unit tests for attention/ and for agent schema/parse functions; replay tests; live model tests and evals (`MODEL_API_KEY`). The existing `npm test` stays green.

## 8. Demo script (draft)

Extension opens → avatar: "Yesterday you stopped at the demo video edit. Pick it back up?" → goal set → work → drift to YouTube; after ~45 s the avatar looks, then speaks → *Take me back* returns to the right tab → on another site *This is for my task* → next time it stays quiet (learning) → rapid tab hopping → fragmentation nudge → today's summary in the side panel.

## 9. Decisions made during design (Claude's call — İrem to check)

Answers to the reviewer's questions, open to İrem's approval:

1. **The goal (intent) is kept as a "shadow" record in attention's DB.** `memory.setIntent()` only takes `{title, next}`, hardcodes the topic as `"focus"`, and its id is a content hash (can change during consolidate). So attention's DB has an `intents` store: `{id: uuid (stable), title, steps[], estMin, topic, createdAt, doneAt?, expiredAt?, memoryEntryId?, fromLoopId?}`. For brain compatibility `memory.setIntent()` / `completeIntent()` are still called and the returned id is stored as `memoryEntryId`; the relevance key and labels use the shadow record's stable `id` and `topic`. No change to Safa's memory API is needed; step 6 is not blocked on anyone. `continueLoopId` = an entry picked from `memory.openLoops()`; continuing creates a new shadow goal with `fromLoopId`.
2. **The old flow is removed.** İrem builds attention, UI/UX and the agent without basing them on Safa's trial (team decision). The 5-minute audit, the popup and the drift notification are replaced by the new flow; `agent/audit.js (removed 2026-11-01)` stays as reference, not wired. `test:e2e` is rewritten for the new flow (fake model: goal → drift → overlay → "Take me back"). The folder ownership table in the README is updated (`agent/` → İrem).
3. **Dialogue runs in the side panel; one-shot calls in the service worker; no free text in the overlay.** The overlay bubble has only buttons and *Talk to me*; *Talk to me* opens the side panel and focuses its input. So the dialogue (LLM#2–#3) runs in the side panel context, where the LangGraph gate is tested. `composeNudge` (LLM#4), `classifyRelevance` (LLM#1) and `reflect` (LLM#5) are one-shot calls; they run as plain functions in the service worker and need no LangGraph.
4. **Goals become open loops at day end.** An unfinished shadow goal gets `expiredAt` on the first active focus of a new local day (day boundary 04:00) or after ≥6 hours away; it no longer counts as active and `session_start` fires. The opening dialogue offers the expired goal as "yesterday you were here", alongside memory's open loops. The rule lives in attention, not in memory.
5. **A broad host permission is accepted.** For the overlay to appear on its own at drift time, `scripting` + `<all_urls>` are needed. The content script only draws the avatar. Since 2026-11-01 the background also runs two small functions in the page for the second look (§10, `src/background/page.js`); the README states what is read. The Web Store submission is optional, so this is not a blocker.

## 10. Notes for later (not in v1)

- **The second look (built 2026-11-01, issue #5; plan: docs/plans/2026-11-01-second-look.md).** URL + title could not tell a work chat from a feed on one site. Before every drift word, the background checks whether the person is typing on the page (focus in a text field and a key in the last minute; yes/no). It reads up to 1,000 characters from where they type or from the middle of the window, a little ahead because that takes a model call (`read_ahead`). The excerpt is redacted, goes to a model that does not train on it, and only the verdict is kept. Never on pages with a password field or on the never-read sites (email among them); on by default, can be turned off.
- **Avatar visual design** in a separate session; v1 uses a placeholder SVG.
- **Safa's MCP server** (after measuring latency) and the **Muse Code connection** are later stages.

## 11. Left to the builder

- Exact thresholds and constants (tuned by replay).
- Title normalisation and per-site detail of the relevance key.
- Prompt text, persona wording, template messages.
- Overlay position, dragging, sizes; side panel layout (except the avatar's visual identity, designed separately).
- Messaging between the service worker and the side panel.
- File split inside `attention/` and `agent/`.
- The JS eval's exact shape (cases as JSONL, graders, baseline file) within `evals/`.

## 12. Addendum (2026-10-31): Tuck on the page

> **Changed 2026-11-04:** clicking Tuck opens the icon row and the goal card, and every goal form is the chat. See `2026-11-04-tuck-dock-chat-design.md`.

Superseded for the avatar, poses, presence on breaks and Tuck away by `2026-11-04-tuck-v1-skins-design.md`.

Approved by İrem from a mockup. The avatar is **Tuck** (assets: `src/tuck/assets/`, from İrem's Tuck v2 paper motion kit): five states — resting, thinking, checkin, welcome, sleeping. Effect colour soft mint `#94BFAE`, body default lilac.

- **Where:** injected into the page in front (`chrome.scripting`), top right, 72 px, in an open Shadow DOM. Reads nothing from the page.
- **Flow:** L1 drift/fragmentation → slides in with *welcome*, settles to *resting*, no text. L2/L3 → *thinking* + bubble with the message and *Take me back* / *This is for my task* / *5-min break*, and × to dismiss. return / break_over → *checkin* + bubble. Answered or back at work on your own → short *welcome*, slides away after 2 s. DND or break → not on the page.
- **Getting started on the page:** first active page of the day with no goal (`session_start`) → *checkin* + "Hi! What are we working on today?" with goal and first-step fields, Start, and up to two "Pick up: …" buttons (yesterday's expired goal, then memory's open loops). Start → *welcome* "Got it — let's go", slides away. After Done → "Nice! What's next?" with the same form. Clicking Tuck with no nudge shows the goal with Done / Change. Inputs swallow key presses so site shortcuts don't fire. The popup form stays as a fallback. **Shortcut (#59):** `open-tuck` (suggested ⌃T on macOS, Alt+Shift+K elsewhere; changeable at `chrome://extensions/shortcuts`) opens Tuck on the page in front: the goal form with no goal; with one, a "Park it for later" field and "Change goal". A parked thought is a `todo` in memory in the person's words, and is named once (in the reminder slot) at the next break's end or finished goal. Esc closes the bubble. Where Tuck cannot draw, the popup opens instead (`chrome.action.openPopup()`).
- **Branding:** the extension is named Tuck; toolbar icons are rendered from `tuck.svg`; the popup header shows a resting Tuck.
- **Calls (Claude's):** message text stays the template text until LLM#4 (Plan 2); goal text is saved as typed until LLM#2 (Plan 2); sleeping Tuck only in the popup.
- **Update (İrem):** Tuck rests on every page while there is a goal (not on a break, in DND or Off), instead of appearing only for nudges; after answers and goal changes it settles back to *resting* rather than leaving. Clicking Tuck is a *checkin* with the goal card. Tuck is draggable; its position is remembered for every page (`tuckPosition`), kept inside the window, and the bubble opens toward the roomier side (rightwards on the left half, upwards on the bottom half).
- **Update (İrem's test):** at L1 Tuck was too quiet (a hop with no text, text only 30 s later), so drift looked undetected. L1 now speaks: a *checkin* wave with the message and the three answers; L2/L3 turn to *thinking* and re-open it. On an unsure page L1 asks "Is <site> part of <goal>?" with *Yes, it's for my task* / *No, take me back*, so the answer becomes a label. Trigger evidence carries `unsure`.
- **Tuck's voice (İrem):** at most 12 words, no emojis, no exclamation marks, plain everyday phrases, the site by its everyday name, never seconds, minutes only from 3 up, the task said as a phrase (next step first), in the user's language. LLM#4 (`src/agent/nudge.js`) writes the line with İrem's example lines as the style; `followsVoice` checks the rules in code, one retry, then the template (`src/tuck/voice.js`, "Next up: …" wording that works for any step phrasing). Lines are drafted ahead: on entering *detour* for L1, and on each drift trigger for the next level. Time away counts from leaving work (`awaySec`), not from the current page.

## 13. Repository layout (2026-11-01)

The repo was reorganised so the root holds only what tools look for. Old → new:

| Before | After |
|---|---|
| `manifest.json` (root; Load unpacked → repo root) | `src/manifest.json` (Load unpacked → `src/`) |
| `attention/`, `agent/`, `memory/` | `src/attention/`, `src/agent/`, `src/memory/` |
| `extension/background.js`, `extension/sensor.js` | `src/background/index.js`, `src/background/sensor.js` |
| `extension/overlay/*.js` | `src/tuck/*.js` |
| `extension/tuck/` (artwork) | `src/tuck/assets/` |
| `extension/popup/`, `extension/options/` | `src/popup/`, `src/options/` |
| `extension/ui.css`, `extension/icons/` | `src/shared/ui.css`, `src/shared/icons/` |
| `test/<area>-<name>.test.js` | `test/unit/<area>/<name>.test.js` (mirrors `src/`) |
| `INTENT.md`, `DECISIONS.md`, `DESIGN.md` | `docs/` |
| `agent/audit.js`, `test/audit.test.js`, `test/live/audit.mjs`, `extension/content/claude-code.js` | removed (in git history); the Muse Code link will be built fresh |

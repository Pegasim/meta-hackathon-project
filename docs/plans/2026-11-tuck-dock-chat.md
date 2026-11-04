# Tuck's icon row and goal chat Implementation Plan

Status: open

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking Tuck opens an icon row with the goal as one step above it; the goal is set and "I'm stuck" is asked in a chat bubble that shows the agent's lookups live.

**Architecture:** Pure view and thread logic in a new `src/tuck/chat.js` (imported by the background, like `present.js`); the overlay draws two new bubble kinds, `menu` and `chat`; the background keeps one chat thread per tab in memory and redraws it on every change. The agent loop gains an `onStep` hook and one new moment, `goalFrom`.

**Tech Stack:** Plain ES modules, Chrome MV3, `node --test`, Playwright (existing e2e only).

**Spec:** `docs/superpowers/specs/2026-11-04-tuck-dock-chat-design.md`

## Intent

Serves: `docs/INTENT.md` § "It actually helps" and the demo flow (design §8).
Change: what matters is one click away on Tuck; the goal is set by talking; the agent's work is visible (Best Agentic).
Out of scope: Settings redesign, side panel, arc menu, voice, stored chat history, new e2e suites.
Open questions: none (see "Deviation" below).

## Global Constraints

- No build step; content scripts are classic scripts injected by `showTuck` (`src/background/index.js:952`), so anything the overlay needs is a `globalThis.tuck*` script added to that `files` list.
- Model calls carrying notes go through `agentChat()` (it already applies `privateSettings()`).
- `src/memory/` untouched.
- UI copy: no em dashes, no emojis, sentence case; Tuck's lines pass `followsVoice` (`src/tuck/voice.js`).
- Icons: Phosphor duotone, MIT, inlined SVG: chat-circle-dots, lightbulb-filament, coffee, check-circle, moon-stars, timer.
- Colors only from the skin theme variables already set by `themeCss` (`--tk-accent`, `--tk-surface`, `--tk-ink`, `--tk-muted`, `--tk-outline`, `--tk-on-accent`; add `--tk-pink` if `themeCss` lacks it).
- Reduced motion: no open animation for the row or the bubble.
- The person's chat text is never logged; run records stay as `logRun` writes them.
- Tests: unit tests for new pure logic; existing `npm run test:browser` and `npm run test:e2e` updated where the changed UI breaks them, no new suites.

## Deviation from the spec (flag at handoff)

The spec says plan dots move when Start this replaces a plan step, with no separate step-done control. That leaves the dots stuck on most demos. This plan adds one small check button on the NOW line of the goal card ("Step done": moves to the next plan step). It lives on the card, not in the row, so the row stays at five icons.

## Review Focus

1. **A goal with no plan:** the card shows title, NOW from `intent.steps[0]` (or nothing), no dots, and no Step done button.
2. **No model configured:** the goal chat sets the person's words as the goal at once; "I'm stuck" in chat shows the template step; nothing waits 20 s.
3. **Tab switch or a new word while the chat is open:** a drift on the chat's tab is held (logged `chat_held`); on another tab it shows as today; the thread is still there when the person comes back to the chat's tab and clicks Chat.
4. **Tuck tucked away:** the shortcut and the greeting still open the chat; closing it leaves (as `current.away` does today).
5. **Saved mode `gentle` or `off`:** the popup switch shows Focus for `gentle`; `off` shows the switch disabled with "Paused in Settings".

---

### Task 1: Agent: `onStep` and the `goalFrom` moment

**Files:**
- Modify: `src/agent/loop.js` (`runAgent` options; call after each `trail.push`)
- Modify: `src/agent/tools.js` (add `goalTools`)
- Modify: `src/agent/moments.js` (add `GOAL` prompt and `goalFrom`)
- Test: `test/unit/agent/loop.test.js`, create `test/unit/agent/goal.test.js`

**Interfaces:**
- Produces: `runAgent(chat, { ..., onStep })`, `onStep(entry: {tool, args, result?})`, called synchronously after every trail entry, errors swallowed.
- Produces: `goalFrom(chat, deps, { said: string }, opts) -> Promise<{value: {title, step|null, kept: boolean} | null, source, trail, ...}>`
- Produces: `goalTools.propose_goal({title, step})`, `goalTools.keep_goal({})`

- [ ] **Step 1: Write the failing tests**

In `loop.test.js`:
```js
test("onStep sees every trail entry as it happens", async () => {
  const seen = [];
  const r = await runAgent(scripted([call("recall_notes", { query: "deck" }), call("done_tool", {})]), {
    system: "s", user: "u", tools: { recall_notes: readTool, done_tool: finishTool }, onStep: (e) => seen.push(e.tool),
  });
  assert.deepEqual(seen, ["recall_notes", "done_tool"]);
  assert.deepEqual(r.trail.map((e) => e.tool), seen);
});
test("a throwing onStep does not stop the loop", ...); // onStep: () => { throw new Error("x") } → r.source === "agent"
```
(Use the file's existing fake-chat helpers; name them as they are there.)

In `goal.test.js`:
```js
test("propose_goal keeps the person's subject", () => {
  const ctx = { said: "the investor deck i guess", notes: [{ title: "Investor deck", text: "slides 6 to 9 missing numbers" }] };
  assert.deepEqual(goalTools.propose_goal.finish({ title: "Finish slides 6 to 9 of the investor deck", step: "Add Q3 numbers to slide 6" }, ctx),
    { title: "Finish slides 6 to 9 of the investor deck", step: "Add Q3 numbers to slide 6", kept: false });
});
test("propose_goal is rejected when it drops what the person wrote", () => {
  const ctx = { said: "the investor deck", notes: [{ title: "Tax form", text: "due Friday" }] };
  assert.throws(() => goalTools.propose_goal.finish({ title: "Send the tax form", step: "Open the tax form" }, ctx), /investor|deck/);
});
test("keep_goal returns the person's words, trimmed", () => {
  assert.deepEqual(goalTools.keep_goal.finish({}, { said: "  fix the cart  " }), { title: "fix the cart", step: null, kept: true });
});
test("goalFrom with no notes ends with keep_goal", ...); // scripted chat: recall_notes → [] then keep_goal; value.kept === true
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/agent/loop.test.js test/unit/agent/goal.test.js`
Expected: FAIL (`onStep` not called; `goalTools` not exported).

- [ ] **Step 3: Implement**

- `loop.js`: add `onStep = () => {}` to the options; after each `trail.push(...)` call `try { onStep(trail.at(-1)) } catch {}`.
- `tools.js` `goalTools`:
  - `propose_goal`: params `{title: string, step: string}` required title. `finish(args, ctx)`: title trimmed, `followsVoice`-free but at most 120 chars; **subject rule**: at least one word of `ctx.said` (via `words()`, first 5 letters, ignoring STOP words) appears in the title, else throw `the goal must keep what the person wrote: "<said>"`; `step` checked with `checkStep(step, grounds(ctx, [ctx.said]))` or null when empty. Returns `{title, step, kept: false}`.
  - `keep_goal`: params `{}`. `finish(_, ctx)` returns `{title: ctx.said.trim().slice(0, 120), step: null, kept: true}`.
- `moments.js` `GOAL` prompt (copy, keep it this short):
  ```
  You are Tuck, a small focus companion. The person just told you what they want to do today, in their own words.
  Their words come first. Look up their notes once about the same thing. If a note is about the same thing, finish
  with propose_goal: their goal made concrete with that note (keep their subject), and one first step. If no note is
  about the same thing, or there are no notes, finish with keep_goal. Never swap their goal for another task, however
  urgent it looks.
  ```
  plus `VOICE`. `goalFrom` = `runAgent(chat, { system: GOAL, user: \`They said: ${said}\`, tools: tools(deps, goalTools, ["look_at_page", "recent_activity"]), ctx: { said, goal: { title: said } }, readRounds: 1, ...opts })`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/unit/agent/loop.test.js test/unit/agent/goal.test.js`
Expected: PASS

- [ ] **Step 5: Commit** `feat(agent): goalFrom sharpens the person's goal from their notes, and onStep shows lookups as they happen`

### Task 2: Intents: focus time and plan progress

**Files:**
- Modify: `src/attention/intents.js`
- Test: `test/unit/attention/intents.test.js`

**Interfaces:**
- Produces: `makeIntent` adds `focusMs: 0`, `focusSince: null`, `stepIndex: 0`.
- Produces: `syncFocus(intent, active: boolean, now: number) -> intent` (same object when nothing changes).
- Produces: `focusMinutes(intent, now) -> number` (whole minutes, floor).
- Produces: `stepDone(intent) -> intent` (next plan step; same object when there is no next one).

- [ ] **Step 1: Write the failing tests**
```js
test("focus time counts only while active", () => {
  let i = makeIntent({ title: "Fix the cart" }, 0);
  i = syncFocus(i, true, 1000);               // Focus on
  i = syncFocus(i, false, 1000 + 10 * 60e3);  // break starts
  i = syncFocus(i, false, 1000 + 15 * 60e3);  // still paused: unchanged
  i = syncFocus(i, true, 1000 + 20 * 60e3);   // back
  assert.equal(focusMinutes(i, 1000 + 28 * 60e3), 18);
});
test("syncFocus returns the same intent when nothing flips", () => {
  const i = syncFocus(makeIntent({ title: "x y z" }, 0), true, 5);
  assert.equal(syncFocus(i, true, 99), i);
});
test("stepDone moves to the next plan step", () => {
  const i = { ...makeIntent({ title: "Deck", steps: ["A"] }, 0), plan: { steps: [{ step: "A" }, { step: "B" }, { step: "C" }] } };
  const n = stepDone(i);
  assert.equal(n.stepIndex, 1);
  assert.deepEqual(n.steps, ["B"]);
  assert.equal(stepDone({ ...n, stepIndex: 2 }).stepIndex, 2, "the last step stays");
  assert.equal(stepDone(makeIntent({ title: "No plan" }, 0)).stepIndex, 0);
});
```

- [ ] **Step 2: Run:** `node --test test/unit/attention/intents.test.js` → FAIL
- [ ] **Step 3: Implement** the four functions; `focusMinutes` = `floor((focusMs + (focusSince != null ? now - focusSince : 0)) / 60000)`; missing fields on old intents read as 0/null.
- [ ] **Step 4: Run:** same → PASS
- [ ] **Step 5: Commit** `feat(attention): a goal counts its focus minutes and which plan step it is on`

### Task 3: Views: the row, the goal card and the chat (pure)

**Files:**
- Create: `src/tuck/chat.js`
- Test: create `test/unit/tuck/chat.test.js`

**Interfaces:**
- Consumes: `focusMinutes` (Task 2).
- Produces: `menuView({ intent, now, agent }) -> view` with `bubble: { kind: "menu", goal: null | { title, now: string|null, dots: null | { done, total }, focusMin, canStep: boolean }, actions: ["chat","stuck","break","done","away"] | ["chat","away"] }`, `pose: "hello"`.
- Produces: `trailLine(entry) -> string | null`.
- Produces: thread helpers on `thread = { mode: "goal"|"step", title, messages: [{ from: "tuck"|"me", text, chips?, buttons?, trail?: string[], pending?: true }] }`:
  `newThread({ intent, opener, chips })`, `say(thread, text)`, `tuckSays(thread, msg)`, `pending(thread, text)`, `addTrail(thread, line)`, `resolve(thread, msg)` (replaces the pending message, keeping its trail).
- Produces: `chatView(thread) -> { pose, bubble: { kind: "chat", title, messages, field: { name: "goal"|"say", placeholder } }, update: true }`.

- [ ] **Step 1: Write the failing tests**
```js
test("the row with a goal: one step, dots, focus minutes", () => {
  const intent = { title: "Fix the checkout bug", steps: ["Write the failing test"], stepIndex: 1, focusMs: 18 * 60e3, focusSince: null,
    plan: { steps: [{ step: "Repro" }, { step: "Write the failing test" }, { step: "Guard" }, { step: "Review" }] } };
  const b = menuView({ intent, now: 0 }).bubble;
  assert.deepEqual(b.goal, { title: "Fix the checkout bug", now: "Write the failing test", dots: { done: 1, total: 4 }, focusMin: 18, canStep: true });
  assert.deepEqual(b.actions, ["chat", "stuck", "break", "done", "away"]);
});
test("no plan: no dots and no Step done; no goal: chat and away only", () => {
  assert.equal(menuView({ intent: { title: "x y z", steps: [] }, now: 0 }).bubble.goal.dots, null);
  assert.equal(menuView({ intent: { title: "x y z", steps: [] }, now: 0 }).bubble.goal.canStep, false);
  assert.deepEqual(menuView({ intent: null, now: 0 }).bubble, { kind: "menu", goal: null, actions: ["chat", "away"] });
});
test("trail lines say what Tuck looked at, never note text", () => {
  assert.equal(trailLine({ tool: "recall_notes", args: { query: "checkout" }, result: "3 notes" }), "Searched your notes: checkout · 3 notes");
  assert.equal(trailLine({ tool: "list_tasks", args: {}, result: "4 tasks" }), "Checked your tasks · 4 tasks");
  assert.equal(trailLine({ tool: "recent_activity", args: {}, result: "5 pages" }), "Looked at your recent pages · 5 pages");
  assert.equal(trailLine({ tool: "look_at_page", args: {}, result: "read 900 characters" }), "Read your last work page");
  assert.equal(trailLine({ tool: "github_status", args: { repo: "acme/shop" }, result: "2 items" }), "Checked GitHub: acme/shop");
  assert.equal(trailLine({ tool: "propose_goal", args: {} }), null, "finishing tools add no line");
});
test("a pending reply collects trail lines and resolves in place", () => {
  let t = newThread({ intent: null, opener: "What are we working on?", chips: ["Send the grant form"] });
  t = pending(say(t, "the investor deck"), "Looking at your notes…");
  t = addTrail(t, "Searched your notes: investor deck · 2 notes");
  t = resolve(t, { from: "tuck", text: "Make it: Finish slides 6 to 9?" });
  assert.deepEqual(t.messages.map((m) => m.from), ["tuck", "me", "tuck"]);
  assert.deepEqual(t.messages[2].trail, ["Searched your notes: investor deck · 2 notes"]);
  assert.equal(t.messages[0].chips[0], "Send the grant form");
  assert.equal(chatView(t).bubble.field.name, "goal");
});
test("every Tuck line in the chat follows the voice", ...); // all fixed strings exported from chat.js pass followsVoice
```

- [ ] **Step 2: Run:** `node --test test/unit/tuck/chat.test.js` → FAIL
- [ ] **Step 3: Implement** `src/tuck/chat.js`. Fixed copy (export as constants): `OPENER = "What are we working on?"`, `LOOKING = "Looking at your notes…"`, `PLANNING = "Making a plan from your notes…"`, `STEP_OPENER = "What's in the way?"`. Thread helpers are immutable (return new objects); `messages` capped at the last 12.
- [ ] **Step 4: Run:** same → PASS
- [ ] **Step 5: Commit** `feat(tuck): the icon row, the goal card and the chat as views`

### Task 4: The overlay draws the row and the chat

**Files:**
- Create: `src/tuck/icons.js` (`globalThis.tuckIcons = { chat, stuck, brk, done, away, timer, check }`: SVG strings, `fill="currentColor"`, 22 px; `check` = Phosphor check-circle at 16 px for Step done)
- Modify: `src/background/index.js:957` (inject `tuck/icons.js` before `overlay.js`)
- Modify: `src/tuck/overlay.js` (`STYLE`, `drawBubble`, `show`)
- Test: `npm run test:browser` + visual check

**Interfaces:**
- Consumes: the `menu` and `chat` bubbles from Task 3.
- Produces (messages the overlay sends): `{type:"chat-open"}`, `{type:"chat-say", text}`, `{type:"chat-chip", title}`, `{type:"chat-closed"}`, `{type:"step-done"}`, plus the existing `stuck-tuck` is NOT used from the row: the row's stuck icon sends `{type:"chat-say", text:"I'm stuck", stuck:true}`; break sends `{type:"respond", choice:"break"}`; done `{type:"complete-intent", from:"tuck"}`; away `{type:"tuck-away"}`.

- [ ] **Step 1: Implement the `menu` bubble.** No `.text` paragraph. Goal card (only when `goal`): muted title; label `NOW`; the step line with, when `canStep`, a 24 px round check button (`aria-label="Step done"`, sends `step-done`); a foot with dots (`done` pink, current accent, rest outline) + `"{done+1} of {total}"` and `timer` icon + `"Focus {focusMin}m"`. Then the pill row (`role="toolbar"`, `aria-label="Tuck"`): Chat (50 px, 1.5 px accent ring, accent fill only while a chat is open), divider, then the actions in order; every button has `aria-label` and a tooltip span shown on `:hover` and `:focus-visible`. The bubble's own background/border/arrow are off for `menu` (`.bubble.menu { background:none; border:0; box-shadow:none; padding:0; width:auto }`, no `::before`).
- [ ] **Step 2: Implement the `chat` bubble** (width 300 px, max-height 360 px, messages scroll, newest in view): header = `title` + Change link (sends `tuck-change`) when a goal runs + ×; messages: Tuck lines left with `class="text"`, the person's right (accent fill); `trail` lines under a 2 px `--tk-pink` rule; `chips` as `button.b` sending `chat-chip`; `buttons` as today's `.row` (each `btn.msg`); a pending message shows its text muted with the trail growing. Field: `input[name=<field.name>]` + `button.b.primary.start` (submit sends `chat-say`). Keep the typed draft and focus when the same chat redraws (`v.update && current?.bubble?.kind === "chat"`): copy `input.value` across and refocus.
- [ ] **Step 3: `show(v)` with `v.update`:** skip timers reset, entrance and `setPose` when the pose is unchanged; just `drawBubble`.
- [ ] **Step 4: × / Tuck click / Esc on a `chat`** sends `chat-closed` (and `goal-form-closed` when the field is `goal`), then closes as today.
- [ ] **Step 5: Check** `npm run test:browser` → `browser test: ok`; load unpacked, click Tuck with and without a goal, compare to `.superpowers/brainstorm/64568-1793805991/content/tuck-menu-v4.html` and `goal-running.html`.
- [ ] **Step 6: Commit** `feat(tuck): clicking Tuck opens an icon row, and the chat opens above it`

### Task 5: The background: threads, the goal chat everywhere, live lookups, focus time

**Files:**
- Modify: `src/background/index.js`
- Modify: `src/tuck/present.js` (`goalForm` callers only)
- Test: `test/unit/tuck/present.test.js` (updated cases), `npm test`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces handlers: `"chat-open"`, `"chat-say"`, `"chat-chip"`, `"chat-closed"`, `"step-done"`; `"tuck-click"` now shows `menuView`.

- [ ] **Step 1: Threads.** `const threads = new Map(); // tabId → thread`. `openChat(tabId, { opener, chips })`: reuse the tab's thread when its mode still matches (goal vs. no goal), else `newThread`; `showTuck(tabId, chatView(t))`. `chat-closed` deletes the tab's thread. A new intent or Done deletes all threads.
- [ ] **Step 2: Every goal form becomes the chat.** In `present.js` `goalForm(text, pickUp)` becomes `{ kind: "chat-start", text, pickUp }`; in `showTuck` (one place), a view whose bubble is `chat-start` is turned into `openChat(tabId, { opener: bubble.text, chips: bubble.pickUp })`. This covers `session_start`, `goal_done`, `card` with no intent, `summon` with no intent (#59), and `tuck-change`. Update the present.test.js cases that assert `kind: "goal"` to `"chat-start"`. The shortcut with a goal running keeps #59's park bubble, and the step thread offers it as a chip, "Park a thought" (opens the `summon` view).
- [ ] **Step 3: `chat-say` with no goal.** Append the person's text; with no model (`agentChat()` null) call `setIntent({ title: text, from: "chat" }, sender)` at once. Else `pending(LOOKING)`, run `goalFrom(agent.chat, await agentDeps(null), { said: text }, { onStep: (e) => redraw(addTrail(...trailLine(e))) })` (skip null lines), `logRun("goal", r, agent.model, r.value?.title)`. Kept or fallback → set the goal with the person's words. Proposed → resolve with `"{title}?"`, its step under it, buttons **Set as goal** (`{type:"set-intent", title, next: step, from:"chat"}`) and **Keep mine** (`{type:"set-intent", title: said, from:"chat"}`).
- [ ] **Step 4: Set from the chat.** In `setIntent`, `from === "chat"`: the thread on the sender's tab switches to mode `step` with `tuckSays("Got it.")`, then `pending(PLANNING)`; `writePlan(intent, { onStep })` (add the option, pass it to `planFor`) appends trail lines and resolves with the steps as one message (numbered text lines) or, with no plan, `"Let's go."`. `chat-chip` = `setIntent({ title, fromLoopId: <the loop's id>, from: "chat" })` (look the loop up by title in `loadLoops()`).
- [ ] **Step 5: `chat-say` with a goal.** Use Safa's `stuck()` with an extra `said` passed into `stepFor` → `stuckStep(..., { title, step, said })` (moments.js: add `said ? \`They said: ${said}\` : "They pressed: I'm stuck"` to the user lines), and `onStep` for the trail. Resolve with the step, `minutesLine`, and Start this / Another one (same `msg`s as `stuckView`).
- [ ] **Step 6: Hold drifts while a chat is open** on the tab in front: in `showTrigger`, next to the `stuck_held` rule, `threads.has(s.current?.tabId)` and a drift kind → log `chat_held` and return.
- [ ] **Step 7: Focus time and steps.** After `apply` in `process()`, `syncFocus(intent, ["focus","gentle"].includes(state.mode) && state.state !== "break", input.ts)`; `putIntent` only when it returns a new object. `step-done` = `stepDone` on the active intent, `putIntent`, then redraw `menuView`.
- [ ] **Step 8: `tuck-click`** (no nudge, not away): `showTuck(tab, menuView({ intent, now: Date.now(), agent }))`. `chat-open` from the row = `openChat` with `STEP_OPENER` when a goal runs, else `OPENER` + the first 2 open loops as chips.
- [ ] **Step 9: Run** `npm test` → all pass (update only the present.test.js expectations named in Step 2).
- [ ] **Step 10: Commit** `feat(tuck): the goal chat replaces the goal form, and Tuck's lookups show as it works`

### Task 6: Modes: Focus or Do not disturb, and Pause Tuck

**Files:**
- Modify: `src/popup/popup.html`, `src/popup/popup.js` (the `#mode` select → a switch)
- Modify: `src/options/options.html`, `src/options/options.js` (a "Pause Tuck" checkbox)

- [ ] **Step 1:** Popup: `<label class="switch"><input type="checkbox" id="focus-switch"> <span id="focus-label">Focus</span></label>`; checked = mode `focus` or `gentle`; label "Focus" / "Do not disturb"; change sends `set-mode` `focus` / `dnd`. Mode `off`: switch disabled, label "Paused in Settings".
- [ ] **Step 2:** Settings: a "Pause Tuck" checkbox ("Nothing is recorded while paused.") sending `set-mode` `off` / `focus`.
- [ ] **Step 3:** Fix the e2e lines that drive `#mode` (`grep -n '#mode' test/browser/*.mjs`) to the switch or the Settings checkbox.
- [ ] **Step 4: Commit** `feat(popup): Focus or Do not disturb in one switch, and Pause Tuck in Settings`

### Task 7: Keep e2e green, docs, demo check

**Files:**
- Modify: `test/browser/extension.mjs` (goal form and card steps), `test/browser/run.mjs` (#59 block: the shortcut now opens the chat)
- Modify: `docs/superpowers/specs/2026-10-31-attention-agent-design.md` §12 (the row and the chat replace the card and form), `docs/DECISIONS.md` (one entry: chat replaces the form; the person's words first; modes)

- [ ] **Step 1:** Replace form steps: `input[name=step]` fills go away; `input[name=goal]` + `button.start` stay as the chat field and send button, so most steps keep working. The fake model answers `goalFrom` with an unknown tool → fallback → the person's words become the goal, so "Got it" still appears. Replace card assertions (`Next:`, plan list) with the `menu` card (NOW line, dots). Do not weaken an assertion; rewrite it for the new UI.
- [ ] **Step 2: Run** `npm test && npm run test:browser && npm run test:e2e`. Expected: unit all pass, `browser test: ok`, e2e as on `main` (known: `copies.mjs` timeout at line 89 also fails on `main`; report it, do not hide it).
- [ ] **Step 3:** Manual demo pass with the real model: morning greeting → chat → "the investor deck" → proposal → Set as goal → plan with live lines → click Tuck → card + row → I'm stuck → live lines → Start this → Step done → Done. Screenshot each.
- [ ] **Step 4: Commit** `docs: Tuck's row and goal chat in the design, and the decision`

## Test plan

Tier: unit (`npm test`) for Tasks 1-3 and 5; integration (`npm run test:browser`, `npm run test:e2e`) kept green; live: one manual demo pass (Task 7 Step 3).
New cases: `test/unit/agent/goal.test.js`, `test/unit/tuck/chat.test.js`, new cases in `loop.test.js` and `intents.test.js`.
Evals: none run (no change to relevance or the task node). `goalFrom` is new; its subject rule is unit-tested, not evaluated.

Done when: `npm test` shows `fail 0`, `npm run test:browser` prints `browser test: ok`, and `npm run test:e2e` fails on nothing that passes on `main`.

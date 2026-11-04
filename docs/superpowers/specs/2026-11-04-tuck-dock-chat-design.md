# Tuck's icon row and goal chat

**Date:** 2026-11-04 · **Owner:** İrem · **Issues:** #61 (I'm stuck UI), #59 (shortcut), #78 (plan)
**Deadline:** the hackathon submission, 2026-11-04 21:00 ET. Demo first.

## Why

Clicking Tuck today shows the goal card or the goal form, and the actions live in the popup,
which people do not open. İrem wants what matters one click away on Tuck itself, and the
morning goal set by talking to Tuck instead of filling a form. "I'm stuck" (Safa, #107) works,
but the agent's work is invisible: a wait line, then a step. For the demo and the "Best
Agentic" prize, the person and the judges should see what Tuck looked at.

## What gets built

### 1. The icon row (approved mockup B, `.superpowers/brainstorm/…/tuck-menu-v4.html`)

Clicking Tuck with no nudge on screen opens one pill beside Tuck, instead of the goal card:

`[Chat] | [I'm stuck] [5-min break] [Done] [Tuck away]`

- Chat is the larger circle with a thin accent ring (not filled, so it does not read as
  pressed); it fills only while the chat is open. A hairline divider; then four plain icons.
- Done ends the goal, as today (my call); a step changes through Start this or the chat.
- Icons: Phosphor **duotone** (MIT), inlined as SVG: chat-circle-dots, lightbulb-filament,
  coffee, check-circle, moon-stars. (My call: duotone, shown in every approved mockup.)
- Each icon has an accessible name and a small dark tooltip on hover and keyboard focus.
- Colors come from the active skin's theme (`skin.json` `theme`), so the kitten gets lavender.
- With no goal, the row shows only Chat and Tuck away (the other three need a goal).
- Clicking Tuck again, Esc, or clicking an action closes the row.
- The actions call what already exists: `stuck-tuck`, the break (`give-me-5` path),
  `complete-intent`, `tuck-away`.

### 1b. The goal above the row (approved mockup B "Now: one step", `goal-running.html`)

With a goal running, a small card sits above the row. It replaces today's goal card
(`present({event:"card"})`); "Next" is gone.

- The goal's title, small and muted.
- **NOW** and the one step the person is on (`intent.steps[0]`), as the hero line.
- Plan dots, only when the goal has a plan (#78): done steps pink, the current one accent,
  the rest outline, then "2 of 4". This needs a new `intent.stepIndex` (0 at set), moved
  forward when Start this or a chat step replaces the current plan step (my call: no
  separate "step done" button, to keep the row at five icons).
- **Focus time:** "Focus 18m", the minutes this goal has been in Focus mode. It counts from
  the goal set while the mode is Focus, pauses during breaks and Do not disturb, and goes on
  when Focus comes back. It does not judge pages: a wrong page verdict cannot bend it.
  New fields on the intent: `focusMs` and `focusSince` (null while paused).
- "Change" is in the chat header, not on the card.

### 1c. Modes: Focus or Do not disturb

- The popup's four-way select becomes one switch: **Focus** on, **Do not disturb** off.
- Gentle leaves the UI; the code and its config stay (a saved `gentle` mode reads as Focus).
- **Off** moves to Settings as **Pause Tuck**: nothing is recorded while it is on.

### 2. The chat bubble

Chat (or I'm stuck) opens a bubble anchored above Tuck (mockup "Then: the chat opens above"):
a header (the goal's title, or "Today"), a short thread, a text field, ×.

**No goal: the goal conversation. It replaces the goal form everywhere** (İrem: the form
is old school). Every place that draws the `goal` bubble today opens the chat instead: the
day's greeting (`session_start`), a new page with no goal (`noGoalView`), "What's next?"
after Done (`goal_done`), Change (`tuck-change`), and the shortcut with no goal (#59).
- Tuck's first message is the line that place says today (the greeting with how the last
  goal went, #46; "Nice work. What's next?"; "What are we working on?").
- The form's "Pick up" chips (open loops) become chip buttons under that first message;
  one tap sets that goal as today (`set-intent` with `fromLoopId`), no model call.
- Closing the chat with no goal keeps today's rule: `goal-form-closed` stops it opening on
  new pages for a while.
- The person types in their own words ("the investor deck i guess").
- **What the person types is the most valuable input** (İrem). The notes never replace it
  or pull it toward something else. A note only widens the goal when it is about the same
  thing the person wrote (it adds the concrete part: "slides 6 to 9"); a note about another
  task is ignored, however urgent it looks. The prompt says this, and `propose_goal` is
  rejected when its title drops the person's subject.
- **No notes, same conversation.** A person with no memory connected still gets the chat:
  Tuck asks what today is about, and with nothing to ground a change it finishes with
  `keep_goal` and asks for a first step in one short line.
- **Tone:** short and direct, one or two short sentences per message, one question at a
  time, no lists or advice. A companion that does not overload.
- One agent run (new moment `goalFrom` in `src/agent/moments.js`, read tools as `planFor`)
  looks at their notes and tasks and finishes with either
  `propose_goal {title, step, why}`: a sharper goal grounded in a note, or
  `keep_goal`: the person's words are already clear, or nothing grounds a change.
- Tuck's reply: the proposed title and its first step, with **Set as goal** (primary) and
  **Keep mine**. No plan yet: one run before the reply, not two (my call).
- Set as goal calls `set-intent` with `title` and `next` = the proposed step. Keep mine sets
  the person's own words, trimmed, with no step (my call: raw words, no cleanup tool).
- After either, the plan runs as today (`planAhead`, #78), and the thread shows it: "Making a
  plan from your notes…", its live lookups, then the steps (my call: the plan is the demo's
  agentic moment, so it shows where the person is looking).
- With no model, or on a fallback, the person's words become the goal directly.

**A goal running: one narrow thread.**
- I'm stuck (from the row or typed) runs Safa's `stuck` flow; the step shows in the thread
  with Start this / Another one (unchanged semantics: `stuckWanted`, one ask at a time).
- Free text with a goal is treated as context for one step: it goes to `stuckStep` as
  "They said: …", and the answer is a step, never open conversation. This keeps Safa's #61
  rule: a focus companion must not become a new place to drift.
- The thread lives while the bubble is open on that tab (my call). It is kept in the
  background per tab (memory only, not storage), so a redraw of the same tab restores it.
  The person's text is never logged (only the run record, as today).
- While the chat is open, drift words are held as a pending "I'm stuck" ask holds them
  (`stuck_held`): the person is talking to Tuck, so it is not drift (my call).

### 3. Tuck's lookups, live

- `runAgent` (`src/agent/loop.js`) takes an optional `onStep(trailEntry)` called after each
  tool call. The default does nothing, so every existing caller is unchanged.
- The background forwards each entry to the tab as a short line under a pink/accent rule:
  "Searched your notes: checkout · 3 found", "Last work page: cart.js", "GitHub: PR #41 open".
  The words come from each tool's existing `summary` and `brief(args)`; never a note's text.
- The same lines stay above the answer once it arrives.
- Only runs drawn in the chat pass `onStep`: the goal conversation, I'm stuck, and the plan
  after a goal set from the chat. "What's next" at Done and plans made elsewhere stay as
  today (my call). A new message appends a line to the open bubble without redrawing it.

### 4. The shortcut (#59, branch `feat/tuck-shortcut-59`)

Merged into this work. The shortcut opens the chat bubble (goal conversation with no goal;
the thread with a goal). "Park it for later" stays as #59 built it, reached from the thread.

## Not built (now)

- The Settings redesign (tabs instead of one long page): a separate change after this one.
- The side panel, an arc menu, voice, a general assistant, a stored chat history.
- Popup changes beyond what Safa shipped in #107.

## Constraints

- Plain ES modules, no build; the overlay draws in its shadow root as today.
- Any model call carrying notes goes through `privateSettings()` (AGENTS rule 5): `agentChat`
  already does.
- `src/memory/` untouched (AGENTS rule 2).
- DESIGN: no em dashes or emojis in UI copy; reduced motion turns the row's open animation off;
  visible keyboard focus.
- Tests: unit tests for new pure logic (present.js views, the `goalFrom` finish tools, the
  `onStep` hook) and the existing e2e kept green where it covers changed behavior (the
  `tuck-click` card path changes). No new e2e suites (İrem: demo first, fewer e2e).

## Left to the builder

Exact spacing and animation of the row, the tooltip, the bubble's maximum height and scroll,
the wording of Tuck's lines within the voice rules (`src/tuck/voice.js`), and how the row is
positioned when Tuck sits at the left edge.

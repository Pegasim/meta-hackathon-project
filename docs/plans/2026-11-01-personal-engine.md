# Notes decide what a page means: page region, notes in the prompt and reminders

Status: open

Issues: #9 (page region), #8 (notes and labels), #10 (reminders), #18 (stale index, Safa)

## Intent
Serves: `docs/INTENT.md` § Outcome ("the better it knows which detours are fine for you") and § Invariants ("Both errors count", "Facts and timing are deterministic").

Change: no fact about the person can decide a label today. A note saying "working with İrem on the hackathon" should mean a conversation with İrem gets no nudge and the feed on the same URL does.

**Conflict to settle in this work:** `docs/INTENT.md` § Constraints and `AGENTS.md` § Project say page content is read only right before a drift word. `pageRegion` reads a conversation's heading when the person works in it. Update both, and `docs/DECISIONS.md`, in the first PR.

Out of scope: Muse Code (#11), avatar work, chat, facts or any extraction from notes, per-host learned tolerance, activity-based budget rates, screenshots, per-site scraping. Exports into entries stay in #6.

*Changed 2026-11-01:* the facts design was dropped after Safa's review. The notes are already distilled, and the canonical form is their own record (`src/memory/README.md`, Entry format).

## Design

### What the LinkedIn check found (2026-11-01, real logged-in session, read-only)

| Finding | Consequence |
|---|---|
| The docked chat lives in an open shadow root under `#interop-outlet`: `role="dialog"`, `aria-label="Messaging"`, with a textbox | The dialog's own label holds no name |
| The dialog's first heading is the other person's name (`h2`) | The name comes from the heading |
| Message options expose text in `aria-label`s ("Options for the message from …") | Read only the heading, never all labels |
| Prototype: wheel in the chat gave `conversation` + the name; wheel on the feed and a click on the conversation list gave `page` | "Last thing touched" works on real LinkedIn |
| Focus stays in the message box while the feed scrolls | Focus cannot say where the person is (matches the #13 finding) |
| The feed scrolls on `main`, not `document` | Use `wheel` and `pointerdown`; do not rely on document scroll |
| In the extension tool's page context, `instanceof Element` was false for shadow nodes, and the first prototype silently returned `page` | Use `nodeType === 1`, and `composedPath()` because `event.target` is retargeted to the host |
| The full page `/messaging/thread/<id>/` has no dialog; the textbox is in `main`, with the name as nearest heading | Needs its own rule (below) |

Not checked: other sites (WhatsApp Web, Slack, Discord), a group chat, minimised chats, a feed post's comment box.

Confirmed on LinkedIn: when the chat sits at the middle of the window and nothing is typed, `readExcerpt` got the shadow host from `elementFromPoint`, whose `innerText` holds no shadow text, so it read the page behind the chat. `pageRegion` covers known people. Fixed in #23: `readExcerpt` reads the conversation last touched, and otherwise goes into open shadow roots at the middle of the window.

### Nodes

```text
Page or chat -> pageRegion -> context.surface
             -> recall(title + host + name)         code, local
  no notes   -> plain prompt; a chat reuses its page's verdict, no second call
  notes      -> classifyPage + up to 5 notes -> cached per goal, page and person
At a natural moment -> pickReminder (pure) -> line + three answers
```

- **`pageRegion`** in `src/background/page.js`: done (step 1).
- **Surface in keys and labels:** `relevanceKey`, `labelKeys` (`src/attention/relevance.js`), per person. A page's label covers its conversations, never the other way. A conversation is no return point. Done (step 2).
- **`notesFor`** in `src/background/index.js`: `memory.recall` finds candidates on any word, and `notesAbout` (`src/attention/relevance.js`) keeps the notes that name the person, or the site, or two title words. Up to 5, redacted; entries whole, plain notes cut around the match. The goal stays out of the query, so a page nothing is known about keeps the plain prompt. Goes through `privateSettings()` (`AGENTS.md` rule 5).
- **`NOTES_RULE`** in `src/agent/relevance.js`: added to the system prompt only when notes were found.
- **Memory changes:** the options page sends `memory-changed`. The worker clears the relevance cache and feeds a `session` input of kind `memory`, so the page in front is judged again. Memory's own reads notice the import (#20).
- **Remembered answers, not two-way learning:** "Take me back" only appears on a page already judged unrelated, so counting it teaches almost nothing, and a page wrongly marked as work never gets the button. So only "No, take me back" on a page Tuck was unsure about is remembered, and settings list what was learned and can forget it.
- **`pickReminder`:** `src/attention/reminders.js`; state `loops` in `chrome.storage.local`, by entry id, so "done" survives a re-import; it also filters `dueSoon` and the "Pick up" list. Shown at a greeting, a return, a break's end and a finished goal, as a deterministic line; no new trigger. Settings list open tasks with Done, for old undated ones that are never raised.
- **`other_commitment`:** fourth label in `src/agent/relevance.js`, with a short list from `taskQueue()`.

Flagged concerns:
- `recall` is keyword search: good on names, weak on paraphrase. The model rejects wrong matches (another Ali, "Create post"); eval cases cover this.
- A chat with one known person about something else counts as work. Accepted.
- The two-memory scene is tested end to end, not by replay, because labels are recorded on the inputs.
- LinkedIn's markup can change. The rule uses roles and headings, not class names; the fallback is `page`, which behaves as today.

## Plan

Each step is its own commit and leaves `npm test` green.

| # | Build | You can see | State |
|---|---|---|---|
| 1 | `pageRegion`, `context.surface` | The event log shows `conversation` and the name | done |
| 2 | Surface in keys, labels, evidence | An answer in a chat does not excuse the feed | done |
| 3 | Notes in the prompt, per-person keys, judging again on import | Same chat, two memories, two responses | done |
| 4 | Remembered no, forgetting labels in settings | Tuck stops asking; a wrong label can go | done |
| 5 | `pickReminder`, answers | "Due today. Still on your list?" | done |
| 6 | `other_commitment` | A page for another commitment gets no nudge | next |
| 7 | Recorded session, full evals | Both error rates reported | |

## Test plan

Tier: unit, replay and integration (e2e against the fake model). Eval for the prompt changes.

New cases:
- e2e: touching a chat in an open shadow root gives `conversation`; scrolling the feed returns to `page`, with focus still in the box; a feed comment box stays `page`; a messaging URL's `main` counts; a chat's answer does not excuse the feed; the same chat is a drift with nothing known and work once the notes name the person, and the feed under it still drifts.
- Unit: per-person keys; a page's key unchanged; a remembered no; `pickReminder` (moments only, once a day, done stays done); notes in the prompt; no notes means the prompt is unchanged; the notes changing means asking again.
- Eval: `notes-*` cases in `evals/relevance/cases.jsonl` (teammate, another Ali, generic dialog, a feed named in a note, Turkish), and `other_commitment` cases. `evals/baseline.json` does not exist yet, so the check is against the `docs/INTENT.md` thresholds.
- Manual on real LinkedIn with the extension loaded, after step 3.

Done when: `npm test`, `npm run test:browser` and `npm run test:e2e` all pass, and `npm run eval` meets `docs/INTENT.md` (accuracy ≥ 85%, false "unrelated" ≤ 5%).

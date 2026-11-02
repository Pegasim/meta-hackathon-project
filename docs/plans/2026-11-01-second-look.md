# Second look before a nudge, and labels that expire

Status: open

## Intent
Serves: docs/INTENT.md § Invariants ("Both errors count") and § Constraints (the v1 URL + title constraint, which this change replaces)
Change: Issue #5. On LinkedIn, messaging a teammate about the project and scrolling the feed have the same URL and title, so Tuck nudged during work. "This is for my task" then made the whole site work for good, which hides the next real drift. Three fixes:
1. "This is for my task" on a whole site lasts 30 minutes, and lasts for good only once it has been given on 3 different days.
2. Before every drift word, Tuck checks whether the person is typing on the page: a yes/no from the focus being in a text field and a key pressed in the last minute (only that time is noted, never the key or the text). If yes, it holds for 2 minutes, twice at most per drift, then speaks (the first word at L1).
3. Tuck also reads a short excerpt of the page near where the person is working and asks the model again. A "related" answer ends the detour or the drift.
Out of scope: screenshots, site-specific scraping, the second look before fragmentation (one page's text cannot tell whether hopping between pages is work).
Open questions: how often the second look turns a drift into work, from the event log after a few days of use.

## Design
- **Engine (pure).** Two kinds of request, and their answers are `second_look` inputs:
  - `read_ahead`, once per page in a detour or drift, a little before the tolerance runs out (`lookLeadSec`), because the excerpt takes a model call.
  - `need_second_look`, before every drift word (L1, L2, L3), when it is due, because typing has to be seen fresh. The word waits for its answer, at most `lookTimeoutSec` per word however many pages pass meanwhile.

  An answer has three outcomes:
  - "related" with enough confidence, whether read ahead or at the word: the page counts as work, but never as a place to go back to.
  - "typing": hold for `holdSec`, at most `maxHolds` times per drift; another page ends the hold.
  - Anything else: the word goes ahead.

  Wake times are only ever in the future. `secondLook: false` turns it all off (the engine's own unit tests use that).
  - *Changed while building:* the first version took one look at the lead time. The e2e showed that typing which starts after that look is missed, so typing is now checked at the word.
  - *Changed after review:* a fresh-context review found four engine bugs, three of them confirmed by script:
    - a 50 ms tick loop while an escalation waited for a look or a hold;
    - no drift ever while hopping between pages faster than the model answers;
    - L2/L3 reusing L1's typing answer;
    - a chat box left focused making a scrolled feed count as work forever.

    Fixed by looking before every word, one wait per word, wake times only in the future, and typing meaning a recent key.
- **Background.**
  - `read_ahead` judges the excerpt and passes on only a "related" verdict. `need_second_look` checks typing, then uses the verdict, waiting for the model at most `LOOK_WAIT_MS` (3 s), so a slow model never stalls a word. There is one model call per page and starting point, shared while in flight.
  - It runs three functions in the page (`src/background/page.js`):
    - `watchTyping` notes when a key was last pressed (installed when Tuck appears on a page).
    - `isComposing` says whether the focus is in a text field and a key was pressed within `typingRecentSec`.
    - `readExcerpt` returns up to 1,000 characters. It starts at the focused field while the person types; otherwise from the conversation last touched (#23), else at the middle of the viewport, into any open shadow root there, so a chat box left focused does not speak for a scrolled feed.

    The functions never read form values, drop every editable draft in the excerpt, and return nothing when a password field is visible (also inside open shadow roots and same-origin frames).
  - The excerpt is read only when the page-reading setting is on (it is on by default) and the site is not on the never-read list (`src/attention/reading.js`).
  - The excerpt goes through memory's `redact()`, then to the relevance node on a model that does not train on it (`privateSettings`: Contributor becomes plain Muse Spark 1.3).
  - Only the verdict is kept, as `look|<focus|view>|<key>` in the relevance cache, for `lookHoldMin` minutes. `knownLabel` uses a fresh "related" verdict only while reading is allowed for the site.
- **Labels.** `nextLabel` / `labelHolds` in `src/attention/relevance.js`.
  - Whole-site labels get `until` and `days`. Title labels (the `TITLE_SENSITIVE` hosts) last as before.
  - Site labels saved before this change carry no `days`, so they no longer hold: they came from one click.
  - Memory hears about a label only once it lasts.
- **Replay.** Replay answers each of the engine's requests at once with the recorded answer nearest to it for that page: the first within `lookTimeoutSec` after, else the last within `lookHoldMin` before. A log then replays as it ran, and a replay with other settings (tuning) still finds the page as it was. A log recorded before this change has no answers, so every look is "nothing seen", which is how that engine behaved.
- **Settings.** A "Page reading" card: the on/off switch and the never-read list.

Flagged concerns:
- Reading pages changes the v1 privacy rule. It is settled in DECISIONS, INTENT, AGENTS.md, the design spec and the README. The guardrails are the password check, the never-read list, `redact()`, a model that does not train on the text, and storing only the verdict.
- A chat box left focused while the person scrolls the feed. Typing needs a recent key, and the excerpt then starts at the middle of the window (the feed), so it does not count as work. A cached "related" from real chatting still counts for at most `lookHoldMin` (5 minutes).
- The excerpt climbs from its start until a container has 300 characters. A chat with only a few short messages can overshoot to the whole page. When typing, the excerpt is the end of that text, which on most sites is the docked chat.

## Plan
Files: src/attention/{config,engine,relevance,replay,reading}.js, src/background/{index,page}.js, src/agent/relevance.js, src/memory/index.js (export `redact`), src/options/options.{html,js}, test/unit/attention/{engine,relevance,replay,reading}.test.js, test/unit/agent/relevance.test.js, test/browser/extension.mjs, evals/relevance/cases.jsonl, AGENTS.md, README.md, docs/{INTENT,DECISIONS}.md, docs/superpowers/specs/2026-10-31-attention-agent-design.md
Order: 1. Labels that expire (pure + background). 2. Engine second look + replay. 3. Page functions, reading gate, excerpt judgement, settings. 4. Docs. 5. e2e.
Risk: the engine change. A look that never gets an answer must not stall a drift (timeout), and a wake time that is already past (a read-ahead just sent, a timeout, an ended hold) must not make the worker tick in a loop.

## Test plan
Tier: unit + integration (e2e against the fake model)
New cases:
- Unit: label expiry and 3-day promotion; read-ahead before the tolerance and the typing check at the word; the word waits for the answer, then times out; "related" ends the detour without becoming a return point; typing holds twice, then L1; another page ends a hold and gets its own look; stale answers ignored; no look in DND; wake times; replay of an old log is unchanged; the never-read gate; the excerpt prompt; Contributor → plain model.
- Unit, after review: L2 re-checks typing; no past wake time while an escalation is blocked; hopping still gets a word; replay with other settings finds recorded answers, and recorded typing holds.
- e2e:
  - a chat page whose excerpt is about the goal gets no nudge, and a draft typed in its box never reaches the model;
  - typing on a feed page holds, then nudges;
  - a docked chat box left focused: the feed is judged and the nudge comes; typing in it then reads the chat, which ends the drift;
  - a page with a password field is not read;
  - reading turned off: a cached verdict no longer counts and nothing is read;
  - "This is for my task" on a site expires.
- Eval: two LinkedIn excerpt cases (a work chat, a feed) beside the existing title-only one.
Evals: relevance eval cases added; not run here (needs the API key).

Done when: `npm test`, `npm run test:browser` and `npm run test:e2e` all pass.

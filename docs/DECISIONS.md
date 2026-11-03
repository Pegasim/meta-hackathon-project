# Decisions

<!-- Append-only. One entry per real choice — if it was obvious, it was not a
     decision. The reason is the load-bearing part: without it the entry reads
     as arbitrary and gets re-argued. Supersede, never delete. -->

## Decided

**A page for another of the person's commitments is not drift, and the log says what each call was sent, as counts (2026-11-03, issue #8).**
Time on the tax form while the goal is the avatar is not a distraction to talk someone back from, and calling it unrelated is the false warning INTENT counts against Tuck. So `other_commitment` is a label of its own: it holds the drift budget like neutral, gets no word, and is never a page to go back to. The model can only find it when it knows the other commitments, so the to-do list's first 5 open titles go in the prompt, redacted, to a model that does not train on them; with an empty list the rule and the list stay out and the prompt is unchanged. Each model call's log record now has `sent`: how many examples, notes and commitments it got, and whether a profile and a conversation heading went with it. The texts stay out, as the excerpt and the model's reason already did, because the log is exported and recordings of it are committed. Measured on a 15-minute recording (`test/fixtures/2026-11-03-avatar`): no warning in 13 minutes of work, both drifts caught, 46 s and 42 s into them; `npm run eval` 98.0% accurate, false "unrelated" 5.0% (one of three runs of `shop-gh-pr`).

**While Muse waits, Tuck asks again, and only asks (2026-11-02, issue #11).**
One command can ask many times on one hook (its stages), and no hook marks an approval being answered: `PreToolUse` fires before `PermissionRequest`, and the next event is `PostToolUse`, once the tool has run. So Tuck cannot tell "still waiting" from "approved and running". One word per status left the person browsing while Muse waited. Tuck now asks again after 30 s in the browser, then 60, 120 and so on; time in the terminal does not count. The wording is a question because it can be wrong, and the gaps grow because a wrong question must stay cheap. Tuck counts drift as usual meanwhile: time on an unrelated page after an approval may still be a wait, which remains an open limit.

**"Muse is done" waits for Muse's answer to be on screen (2026-11-02, issue #11).**
Muse fires `Stop`, runs its internal helpers, and only then shows the answer: 3.2 s and 5.9 s later in two timed headless runs, with helpers up to 2.7 s apart. Tuck said "done" while the person still saw it working. No hook marks the answer being shown, so the bridge holds the end of a turn until hooks from every session have been quiet for 3.5 s, 15 s at most, so the word can trail the answer by that much. An approval goes at once, since Muse shows it already. The wait lives in the bridge: it is about Muse's timing, and the engine stays unaware of it.

**One drift stays one drift, and words are spaced by time off task (2026-11-02, issue #37).**
A recorded session showed two faults. Time waiting for the model never counted, so hopping faster than it answers looked like no drift at all. And any glance away ended the episode while the budget stayed high, so the next page fired a new L1 at once: eight words in 5.5 minutes, none past L1. The wait now counts once the model says unrelated, and the next word needs `escalateAfterSec` more seconds off task, whatever the clock says, because a glance or time in a terminal says nothing about drifting further. A drift ends on a real absence or once work has drained the budget well below the tolerance. Quiet after the last word holds for that page only: a new page starts over, or hopping would end in silence. A page still waiting counts as neutral, so no word is ever said about a page not yet judged.

**A small local bridge tells Tuck whose turn it is in Muse Code, status only (2026-11-02, issue #11).**
While an agent works, time on another page is a wait, not drift, and when it stops the person should hear it where they are. A browser extension cannot hear a hook, so this is the one exception to "no separate backend": the hook appends a status line to a file, and a native messaging host Chrome starts passes it on, so the hook needs nothing running. Prompts, messages and terminal output never leave the hook; whether a turn ended in a question is worked out there. Tuck cannot bring a terminal to the front, so the word offers "Got it", not "Take me back".

**The tab-hopping nudge is off by default, and counts only time the model was sure about (2026-11-02, issue #30).**
It fired during real work: six tabs in two minutes is normal (docs, repo, chat, a PR), and the pattern looks the same whether someone is working or not, so the nudge read as a false accusation. Sustained off-task time already reaches the drift nudge in about 45 s, whatever the switch count; what is lost is quick hopping between work and off-task tabs, where the work tabs keep draining the budget. Behind `fragmentation: true` it still works, now counting only confident "unrelated" time and with wording about the tabs, not the switching. The thresholds (6 switches, 50%) are unchanged: they are guesses, and changing them without replaying real sessions would swap one guess for another.

**The to-do list is read from the open loops by a model at import; what is urgent stays in code (2026-11-02, issue #29).**
Memory counts every entry with a next action as an open loop, and on a real brain that was 225 items, 9 of them todos. Rules on kind or age cannot tell "send the papers" from "keep an eye on the bill", or see that a later note closed a task, so a model reads each candidate once, with the other notes on its topic, and says whether it is a task, still open, and its title in 10 words. It never orders them: the deadline is read from the text and the queue keeps memory's order, as INTENT.md asks. Verdicts are cached by entry and content, so a re-import asks only about what changed (on that brain, 15 calls the first time, then none). A task closed on another topic, or never written down, stays listed; Not a task and Done take it out for good.

**"Take me back" teaches only as the answer to Tuck's question; labels can be forgotten in settings (2026-11-01, issue #8).**
Counting every "Take me back" was the plan, but the button only appears on a page already judged unrelated, so it adds little, and a page wrongly marked as work never gets a nudge to answer. So a no on a page Tuck was unsure about is remembered at once, for that page's title or that conversation, never the whole site: a repo on the same host can be the work. Settings list what was learned. A later yes takes the no back. Forgetting a label does not remove a preference already written to memory, since a lasting label writes one and `src/memory/` has no way to remove it yet.

**Reminders name what is due at moments that already exist, in a fixed line (2026-11-01, issue #10).**
Urgency changes what Tuck says, never how often it interrupts: a greeting, a return, a break's end and a finished goal, once per task per day. The notes have no way to mark a task done, so "done" is kept in the extension by entry id. A line a template can write needs no model call.

**Notes reach the page decision through memory's search, with no second form (2026-11-01, issues #8, #6).**
The notes are already distilled, so a facts layer on top of them would repeat that work. The canonical form is their own record; other sources become entries once, at import, in #6. The search finds candidates in code, with up to 5 notes going to the model for that page or person: the model is stateless, so sending every note means sending them all on every call, and the search alone also matches another Ali or a "Create post" dialog. It costs one model call per page or person with matching notes, and a replay cannot show two memories, so that scene is tested end to end.

**Tuck notes which conversation the person last touched, by its heading, not only before a nudge (2026-11-01, issue #9).**
Notes should decide what a page means: a conversation with someone the person works with is work, and the feed on the same URL is not. That needs the name, immediately and with no model call, and opening a chat fires no Chrome event. So a listener notes the last container touched (a dialog with a text box, or the main area on a messaging URL); touching anything else ends it, because the focus stays in the chat's box while the feed scrolls (seen on real LinkedIn). Only the heading is read, since LinkedIn's labels hold message text. It goes to the model only when the person's notes mention that name, and is not read on never-read sites or with reading off. Keeping it is deliberate, the one piece of page text that is kept: in the event log for 7 days, in verdict and label keys, and in the preference memory gets once a conversation's label lasts, which the export also writes to the brain inbox. A verdict or label per person needs the name, and everything stays local unless the person connects a brain.

**Before a drift word, Tuck looks at the page again: typing, then a short excerpt (2026-11-01, issue #5).**
URL and title cannot tell a work chat from a feed on the same site: Safa was nudged while messaging a teammate about this project in LinkedIn's chat window. Typing is a yes/no checked before every drift word: focus in a text field and a key pressed in the last minute (only that time is noted). The excerpt is read a little ahead because it takes a model call: up to 1,000 characters from where the person types, else from the middle of the window. It is redacted, sent to a model that does not train on it, and only the verdict is kept. It rules out screenshots and site-specific scraping, and it never runs on pages with a password field or on the never-read sites.

**"This is for my task" on a whole site lasts 30 minutes; for good only after 3 different days (2026-11-01, issue #5).**
One click meant "this visit is work", but it made the whole site work forever, which hides the next real drift there (the feed after the chat). Title labels (YouTube and the like) still last.

**{{The decision, in one sentence.}}**
{{Why, and what it rules out.}}

## Rejected

- **{{The attractive idea that keeps coming back}}** — {{the concrete reason it fails here}}

## Superseded

- ~~Relevance from URL + title only (v1, under test)~~ — 2026-11-01, replaced by the second look: the hypothesis failed on mixed sites (issue #5).
- ~~{{old decision}}~~ — {{YYYY-MM-DD}}, replaced by {{new}}: {{why it changed}}

## Open

- {{question}} — settled by {{what evidence would decide it}}

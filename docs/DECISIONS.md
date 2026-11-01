# Decisions

<!-- Append-only. One entry per real choice — if it was obvious, it was not a
     decision. The reason is the load-bearing part: without it the entry reads
     as arbitrary and gets re-argued. Supersede, never delete. -->

## Decided

**A small local bridge tells Tuck whose turn it is in Muse Code, status only (2026-11-02, issue #11).**
While an agent works, time on another page is a wait, not drift, and when it stops the person should hear it where they are. A browser extension cannot hear a hook, so this is the one exception to "no separate backend": the hook appends a status line to a file, and a native messaging host Chrome starts passes it on, so the hook needs nothing running. Prompts, messages and terminal output never leave the hook; whether a turn ended in a question is worked out there. Tuck cannot bring a terminal to the front, so the word offers "Got it", not "Take me back".

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

# Tuck — a focus companion

Chrome extension (MV3): Tuck, a little folded companion that knows what you meant to do, notices when you drift, and appears on the page to talk you back. Optional later: a connection to a Muse Code session.

Built during the Meta AI developer hackathon. Design inspired by a private personal knowledge system; no code reused.

## Layout

```
src/                 the extension — "Load unpacked" points here
  manifest.json
  background/        service worker: Chrome events → engine → event log, model calls, Tuck
  attention/         the attention engine (pure, no Chrome): relevance keys, drift budget,
                     states, triggers, policy, shadow goals, replay, event log store
  agent/             LLM nodes, structured output: relevance.js (LLM#1), nudge.js (LLM#4), profile.js (LLM#5), tasks.js (LLM#6)
  memory/            Safa's memory: entries, recall, context pack, brain folder (see src/memory/README.md)
  tuck/              Tuck on the page: overlay, bubble layout, what to show, voice
    assets/          Tuck's artwork and motion (SVG + CSS, five states)
  popup/  options/   the toolbar popup and the settings page
  shared/            ui.css and the toolbar icons
test/
  unit/              node tests, mirroring src/ (unit/attention, unit/agent, unit/memory, …)
  browser/           the real extension in Chromium (Playwright)
  live/              real-model checks
  fixtures/          recorded sessions for the replay criteria
evals/               npm run eval: relevance accuracy against the real model
scripts/             make-icons.mjs renders the toolbar icons from src/tuck/assets/tuck.svg
checks/              pre-commit checks
docs/                INTENT.md, DECISIONS.md, DESIGN.md, guides/, design specs and plans
```

| Folder | Owner |
|---|---|
| `src/memory/` | Safa |
| `src/attention/`, `src/agent/`, `src/tuck/`, `src/background/`, `src/popup/`, `src/options/`, `evals/` | İrem |
| `test/` | both |

## Status

Memory is complete and tested (node and real Chromium): entries, consolidation, topic-aware recall, context pack, activity log, distill, scheduled upkeep, and the brain folder connection (import, export, re-sync from the remembered folder). See [src/memory/README.md](src/memory/README.md).

The attention engine works end to end in Chromium against a fake model (`npm run test:e2e`): goal from the popup, each page judged against it, drift after the tolerance, badge and nudge, *Take me back* (also when the related tab was closed), *This is for my task* silencing that page next time, and the exported event log. The engine itself is unit-tested in node (`npm test`).

**Muse Code (optional, macOS or Linux; Google Chrome, and Chromium on Linux):** `node bridge/install.mjs <project folder>`, then reload Tuck in `chrome://extensions`. On Linux it has been tried with Muse Code 1.4.14 and Google Chrome 156 from the `.deb` package: working, waiting and done all reach Tuck. Flatpak browsers are not supported: Flatpak Chromium keeps its host manifests under `~/.var/app/org.chromium.Chromium/config/chromium/`, a folder the installer does not write to. In one test it did start the bridge after the manifest was copied there by hand, with this repo and Node under the home folder. While the agent works, another page counts as waiting, not drifting, and Tuck says when it stops. Only its status is read, never a prompt, a message or terminal output.

**Privacy:** the companion judges pages by URL and title. It also notes which conversation you are working in, by its heading only. That name goes to the model only when your notes mention that person, together with those notes. It is the one piece of page text that is kept, on purpose: in the event log for 7 days, in the keys of verdicts and labels, and, once you have marked that conversation as work on 3 different days, in a preference written to memory, which also goes to your brain folder if you have connected one. Right before it would nudge you about a page, it checks whether you are typing there (it notes when you last pressed a key, never which key) and reads up to 1,000 characters near where you are typing, or from the conversation you last touched, or from the middle of the window, so a work chat on a social site is not taken for drifting. Secrets are removed first; on Meta the excerpt goes to Muse Spark 1.3, not Contributor, so it is not used for training; only the verdict is kept. Pages with a password field and a never-read list (banks, government, health, password managers, email; editable in Settings) are never read, and reading can be turned off. No screenshots. At import, the notes that name a next action go to the same model once, secrets removed, so Tuck keeps a short to-do list. With them go the title, date and result line of other notes on the same topic, and a short summary of the last day's browsing (at most 6 sites, the minutes on each and 2 page titles), so a task already done or under way leaves the list; the browsing is only evidence for that and never makes a task. Then the tasks that look alike go to it in pairs, so one commitment written in several notes is one row. Only its verdicts are kept, and a re-import sends only what changed. Other notes are yours to add in Settings: a notes folder (Obsidian or plain Markdown) is read in the browser and never written to, and a pasted "what my assistant knows about me" is shown to you first, then sent once, secrets removed, to Muse Spark 1.3 (not Contributor) to be turned into entries. A Claude or Gemini account export is read in the browser too, and only some of it is sent, the same way: conversations from the last 30 days in which you name a date or a to-do, at most 50, one at a time, after Settings shows how many and you press Import. When a goal ends, Tuck writes one entry about it to memory (and so to a connected brain folder): the goal, the minutes on it, drifts, nudges and the last site worked on, never a page title; the next greeting says how it went. The event log stays on this device for 7 days.

Not done:
- The avatar overlay, side panel chat and agent dialogue (plan 2).
- A real Chrome session on a laptop: real folder picker, real idle and focus events.
- The Muse Code / claude.ai/code session link (later stage; to be built fresh).

## Brain compatibility

Entries use the second-brain record format (`Date · Context · Decision/Result · Evidence · Next action`, plus `kind`, `topic`, `title`, `source`). A brain checkout can be imported, and new entries can be written into its `inbox/` in the same format. Brain content is never committed here (`brain/` is gitignored).

## Demo data

The demo runs on the author's own second brain, loaded locally at demo time. It is not part of this repo.

## Develop

```
npm test                  # node unit tests
npm run test:browser      # memory API inside the extension in Chromium; needs Playwright
npm run test:e2e          # the whole extension against a fake model; needs Playwright
npm run test:live         # real model call; needs MODEL_API_KEY in the environment
```

## Try it

1. `chrome://extensions` → Developer mode → Load unpacked → the `src/` folder.
2. Pin the extension, open Settings (from the popup), pick a provider, paste the key, Save, Test connection.
3. Optional: Connect folder → your second-brain checkout. Or, under Other memory, add a notes folder (Obsidian or plain Markdown; unchecked `- [ ]` items become tasks), paste what Claude, ChatGPT or Gemini says it knows about you, or add a Claude or Gemini account export (`conversations.json`, or `MyActivity.json` from Google Takeout).
4. Open any web page: Tuck greets you at the top right and asks what you are working on. Browse. About 45 seconds on an unrelated page and Tuck slides in; stay longer and it asks you to come back. The popup has the same controls; the options page exports the event log.

Secret scanning: `pre-commit install` (gitleaks). The fake keys in `test/consolidate.test.js` are fixtures for the redactor.

## License

MIT

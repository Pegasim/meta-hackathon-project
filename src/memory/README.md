# memory/

The agent's memory. Runs inside the extension (IndexedDB), and can import or write to a second-brain folder in the same Markdown format. The extension uses it only through `Memory` in `index.js`.

## Pipeline

```
tab events ──recordActivity()──► activity ──activity()──► "github.com 14 min, youtube.com 15 min"
                                     │
                                     └──distill(model)──┐
add() ─────────────────────────────────────────────────►├─► inbox ──consolidate()──► log ──► recall ──► contextPack()
                                                         │        (validate, redact,             (BM25,
importBrain(folder) ──► log + notes ◄────────────────────┘         dedupe, stable id)             topic-aware)
                         ▲                                                   │
                         └──────── syncBrain() ◄── brain folder ◄── exportPending()
maintain() (every 15 min): consolidate + prune activity older than 7 days + exportPending
```

| File | What it does |
|---|---|
| `entry.js` | Entry format and validation; inbox Markdown in and out |
| `brain.js` | Reads a brain checkout: `inbox/`, `notes/log/`, other notes; open loops |
| `consolidate.js` | Inbox → log: validate, redact secret-shaped strings, drop unchanged restatements, id |
| `recall.js` | In-memory BM25 over entries and notes. İ/I/ı/i fold to one letter; diacritics stripped; URL debris ignored. `topicSearch` boosts topics the tab names or the stated intent belongs to; nothing is excluded |
| `context.js` | Context pack: latest intent, open loops and notes related to the current tab, rendered for a prompt; the task queue |
| `due.js` | Deadlines derived from entry text, and day arithmetic (see Entry format) |
| `activity.js` | Tab events → time spans → per-site summary |
| `distill.js` | Prompt and parser for turning activity into entries (the model call is passed in) |
| `exports.js` | An assistant's account export (Claude `conversations.json`, Gemini Takeout `MyActivity.json`) into conversations, and the few that are sent: the last 30 days, a date or a to-do in the person's own words, newest first, at most 50. Each goes through the paste prompt with its own date as today, at low effort, three at a time; what each gave is cached by its last message, so the same file again sends only what changed. User and assistant text only: attachments, tool calls and Canvas documents stay out |
| `paste.js` | Prompt and parser for turning a pasted assistant memory into entries: redacted and capped first, one call per paste (the model call is passed in). An entry is dated today, or earlier when its own text names an earlier date, so a deadline already missed still reads as one |
| `markdown.js` | Any Markdown folder (Obsidian, plain notes) → `todo` entries for unchecked `- [ ]` items (with Obsidian's `📅` and `due::` deadlines) and a document per file. Pure; `sources.js` reads the folder with `readTextFiles` |
| `sources.js` | Origins and the folder readers by kind (`READERS`: `brain`, `md`) |
| `model.js` | OpenAI-compatible client; provider presets; settings storage |
| `db.js` | IndexedDB stores: `entries`, `notes`, `activity`, `meta` |
| `connector.js` | Folder access (File System Access API): read the brain or any folder of `.md` files, permissions, write into the brain's `inbox/` |
| `sources.js` | Where memory comes from: `origin`, and the reader for each kind of folder |
| `index.js` | The `Memory` API below |

## API

```js
import { Memory } from "../memory/index.js";
import { modelClient, loadModelSettings } from "../memory/model.js";
const memory = await Memory.open();

// Sources (see Sources below)
await memory.importEntries({ origin, name, entries, documents }); // an adapter's output; replaces that origin only
await memory.connectFolder(dirHandle, { kind, origin?, name?, read? }); // remember a read-only folder and import it
await memory.syncSource(origin, { prompt });   // re-read a connected folder, the brain included
await memory.sources();                         // [{ origin, kind, name, entries, documents, openLoops, connected, lastImport }]
await memory.removeSource(origin);              // drop all of it; { entries, notes }

// Brain
await memory.connectBrain(dirHandle);           // remember the folder and import it
await memory.syncBrain({ prompt });             // re-import; prompt: true only from a click
await memory.exportPending({ prompt });         // write consolidated own entries into its inbox/

// Entries
await memory.add({ kind, topic, title, context, result, evidence?, next? }); // the stored entry, with its id
await memory.remove(id, { key });               // take it back; see Removing an entry
await memory.consolidate();                     // { accepted, duplicates, rejected, redactions }
await memory.recall("query", { limit });        // [{ ref, title, score, item }]
await memory.openLoops();                       // entries with a next action
await memory.latestIntent();                    // newest todo
await memory.taskQueue({ today, limit, staleAfter, distilledFor }); // open loops by time left; each has due, daysLeft and writer
await memory.profileSample({ limit });         // newest entries as { topic, title, next, date, result }, for the profile and task calls
await memory.profile();                        // { summary, topics, workHosts }, or null before the first read
await memory.setProfile(profile);              // stored in IndexedDB meta
const { pack, prompt } = await memory.contextPack({ title, url });

// Activity: call on tab activation, URL/title change, and window blur / chrome.idle
await memory.recordActivity({ url, title, kind: "focus" | "idle" });
const { spans, summary, text } = await memory.activity({ minutes: 60 });

// Distill: a model turns recent activity into inbox entries
const complete = modelClient(await loadModelSettings());
await memory.distill(complete, { minutes: 60 });

// Upkeep (background alarm)
await memory.maintain();

// Caches: entries and the search index are cached per instance. Every write stores a fresh
// stamp, and a read reloads when the stamp changed, so the options page and the worker see
// each other's writes on their next read.
memory.refresh();                              // drop this instance's copy; the next read reloads
await memory.version();                        // the stamp of the last write by any instance

// Redaction for any text that leaves the device (a page excerpt): { text, count }
// entryKey(entry): its date, topic and title, the second way remove() finds it
import { redact, entryKey } from "../memory/index.js";
```

## Sources

Every entry and document carries an `origin`, where it came from (`sources.js`):

| Origin | What | Written to |
|---|---|---|
| `brain` | The second-brain folder (`connectBrain`) | Yes: `exportPending()` writes the extension's own entries into its `inbox/` |
| `md:<folder name>` | Any folder of `.md` files (`connectFolder(dir, { kind: "md" })`), read by `markdown.js` | Never |
| `paste:<id>` | What an assistant said it knows, turned into entries once (`importEntries`) | Never |
| `export:<claude\|gemini>:<file>` | The recent conversations of an account export that name something owed (`exports.js`), turned into entries through the paste prompt (`importEntries`) | Never |
| none | The extension's own entries (`add()`, `distill()`) | Into the brain, once each |

`source` is another field: who wrote the entry (claude-code, distill, extension).

- **One source at a time.** An import replaces what the last import of that origin brought, and nothing else: a brain sync leaves a Markdown folder and a pasted memory as they are. `importFiles(files)` is the brain's (`origin: "brain"`); `importEntries()` takes any adapter's entries and documents.
- **Records from before origins** have none: with a `path` they count as the brain's, without one as the extension's own.
- **Ids and paths.** Outside the brain, an entry's id is `<origin>|<id>` and a document's path `<origin>/<path>`, so one note in two folders is two records. Entries that fail validation are skipped and reported in `skipped`; the brain's are kept as read.
- **Removing a source** drops its entries, its documents and its folder. A later `syncSource()` finds no folder (`{ connected: false }`), also when the removal came from the other instance while it was reading. Connecting the folder again, or importing that origin again, brings it back: that is the explicit way back. Removing the brain keeps the extension's own entries, and nothing is exported until a brain is connected again.
- **Removing one entry** (`remove()`, below) works in every source, and a later import of that source does not bring it back.
- **A new kind of folder** adds a reader to `READERS` in `sources.js`: `read(dirHandle) -> { entries, documents, skipped }`. `connectFolder` and `syncSource` find it by the origin's kind, in the options page and in the worker alike. `readTextFiles(dir)` in `connector.js` returns every `.md` file as `{ path, text, lastModified }`, hidden folders skipped.

## Entry format

One format for everything. An entry is the second-brain record (`Date · Context · Decision/Result · Evidence · Next action`), and it is the canonical form: other sources (a plain notes folder, what an assistant remembers, an export) are mapped into it, and nothing downstream reads a second form.

| Field | Rule |
|---|---|
| `kind` | `decision`, `fact`, `preference`, `event`, `lesson` or `todo` |
| `topic` | a slug: `a-z`, `0-9`, `-` |
| `title` | 3-120 characters |
| `date` | `YYYY-MM-DD`; today when omitted |
| `source` | where it came from; `extension` for entries made here |
| `context`, `result` | required |
| `evidence`, `next` | stored as `none` when empty |

`validate()` in `entry.js` is the source of truth.

**Files.** An inbox entry is Markdown: frontmatter (`kind`, `topic`, `title`, `date`, `source`, `host`) and a body of `Context:`, `Decision/Result:`, `Evidence:` and `Next action:` lines. An entry under `notes/log/` carries the same fields as `- **Context:** …` bullets, plus an `id`. Only `inbox/` and `notes/` are read, and `inbox/_done/` and `inbox/README.md` are skipped. Any other `.md` under `notes/` is a document, `{ path, title, text }`: searchable, and never an open loop. An entry is small and a document is not. In one real brain of 1,498 entries, an entry's text has a median of about 1,000 characters and a largest of 1,908, while the 120 documents have a median of about 3,600, a 95th percentile of about 45,000 and a largest of about 390,000. A caller that passes documents to a model must cap them; entries can go uncut.

**Open loop.** An entry whose `next` is anything but `none`. That is the whole test. Nothing in the brain marks a loop done.

**Deadlines.** There is no due field, on purpose: `brain consolidate` rewrites an entry's frontmatter with a fixed set of keys, so a `due:` written here would be dropped on the next nightly run. `due.js` derives the date from the text instead, so notes written before Tuck existed already carry one.

- It looks in `next`, `result`, `title` and `context`, for an ISO date (`2026-11-09`).
- A date counts only with a cue beside it: `due`, `deadline`, `closes`, `expires`, `last day`, `son başvuru`, `son tarih` or `teslim`, up to 32 characters before the date or 16 after. A cue never reaches across another date, so in "runs 2026-11-13 to 2027-01-05; deadline is 2026-12-01" only the last date is a deadline.
- A date earlier than the entry's own date is ignored, and the earliest remaining date wins.
- No cue, no deadline. A deadline read wrongly is worse than none.
- Dates in plain words ("closes today") are not parsed.

**Task queue.** `taskQueue()` orders open loops by time left, as plain arithmetic with no model call: dated loops soonest first, then undated ones newest first, then loops whose deadline passed more than `staleAfter` days ago (14 by default), because nothing marks a loop done and an old note would otherwise sit at the top forever. Days are counted on the user's local date, not UTC (`localDate()`).

**Who wrote a loop.** Each loop carries `writer` (`writtenBy()`): `own` for the person's (a Markdown folder, a goal set in the extension, a paste, an export, `brain add` run by hand, which writes `source: manual`), `agent` for a coding agent's session note in a brain (any other `source`, such as `claude-code`), and `distilled` for a distill job's (`source` naming `distill`, such as the brain's nightly `brain-distill`). Within one deadline, and among the undated, own loops come first, then an agent's, then distilled ones. A distilled loop older than `distilledFor` days (14 by default) is left out, unless its deadline is still live: the distill job restates work that comes up again, so an old one is the state of a finished session (#76).

**Ids.** An entry read from `notes/log/` keeps the `id` in its file. Every other entry gets `entryId()`: a hash of its date, topic and title plus its title, context, result, evidence and next. The same entry gets the same id on every import, and editing any of those fields gives it a new one. Whether an inbox entry keeps its id once the brain's own `consolidate` has filed it is not verified.

**Removing an entry.** `remove(id, { key })` takes back an entry the extension wrote, such as the preference a lasting "This is for my task" adds, once the label is forgotten in settings. `id` is what `add()` returned; consolidation keeps it as `addedAs` when redaction gives the entry a new one. `key` is `entryKey()`, for a copy the brain filed under an id of its own.

| Where the entry is | What `remove()` does |
|---|---|
| This memory only (inbox, or log and not exported) | Deletes it. `exportPending()` never sees it. |
| Exported, and its file is still in the brain's `inbox/` | Deletes it here, and the file too when write access is already granted (no prompt). The file is found by the name it was written under, and deleted only if it still holds that entry. Without access it stays, and `file` says `"kept"`. |
| Filed by the brain (`inbox/_done/`, `notes/log/`) | Deletes it here and leaves the brain's files alone. |

In every case its id and key are kept in `meta` (`removed`), and `importFiles()` skips an entry that matches either, so a sync of a brain that still holds it does not bring it back. Other instances see the removal on their next read, as with any write. To take it out of the brain itself, delete it there.

**Profile.** `profile()` is what `src/agent/profile.js` read from the newest entries (`profileSample()`): a short summary, the topics that are the person's work, and the sites that are. It is stored in IndexedDB `meta` and read from there on every call, so unlike the entries it is never stale.

## Model

`model.js` speaks OpenAI-compatible chat completions. Presets:

| Preset | Model | Note |
|---|---|---|
| `meta` (default) | `muse-spark-1.3` on Meta's Model API | Standard price, not used for training |
| `meta-contributor` | `muse-spark-1.3-contributor` on Meta's Model API | Not offered in settings. It still resolves so settings saved earlier load, and `privateSettings()` swaps it for `meta` on every call that carries notes: Meta may train on what Contributor is sent |
| `openrouter` | `meta/muse-glimmer-30b` | Muse Glimmer is not served on Meta's Model API |
| `ollama` | `muse-glimmer` on `localhost:11434` | Local; no key. Ollama must allow the extension origin (`OLLAMA_ORIGINS`) |
| `together`, `fireworks`, `baseten`, `groq`, `nebius` | Muse Spark Open | The hosts Meta's deploy docs list; not on Meta's Model API |
 Settings, including the API key, are kept in `chrome.storage.session` (cleared when the browser closes) unless the user chooses to remember them on the device.

Live check: `npm run test:live` (one ping and one distill), with `MODEL_API_KEY` in the environment. Relevance against the real model: `npm run eval`.

## Not tested

- A brain folder chosen with the real folder picker: tests use an origin-private folder. Whether Chrome asks again for permission after a restart is unknown; `syncBrain()` reports `needsPermission` when it does.
- Distill against a real model (the live script exists; it needs a key).
- Embeddings: recall is keyword-only.

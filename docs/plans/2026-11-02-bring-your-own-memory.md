# Bring your own memory: Markdown folders and pasted assistant memory

Status: open

## Intent
Serves: docs/INTENT.md (Tuck knows what you owe, not only what you clicked) and issue #6.
Change: today the memory layer reads one layout, a second-brain checkout, so anyone else starts with no commitments. Two new sources, each mapped into the existing entry format (`makeEntry`, see `src/memory/README.md` § Entry format), with no second form:
1. Any Markdown folder (Obsidian, plain notes): unchecked `- [ ]` tasks become `todo` entries; files and headings become searchable documents.
2. "What my assistant knows about me": the person asks Claude, ChatGPT or Gemini to list what it remembers and pastes the answer; one model call turns it into entries.
Out of scope (later): model-assisted discovery of an unknown folder, the Claude, ChatGPT and Gemini export parsers, zip files, merging one commitment that arrives from two sources.
Open questions: none blocking. Stale loops are handled by the task node (#29) and Done.

## Design
- **Memory by source (A).** Every entry and document carries `origin`: `"brain"`, `"md:<folder name>"` or `"paste:<id>"`. `source` keeps its meaning (who wrote the entry: claude-code, distill, extension). `importFiles(files, { origin })` replaces only that origin's entries and documents; the brain import keeps working as today with `origin: "brain"`, and entries stored before this change count as `"brain"` (or the extension's own when they have no `path`). `sources()` lists each origin with its counts; `removeSource(origin)` drops all of it, and it stays out of later imports, like `remove()` (#25). Only the brain folder is ever written to (`exportPending`); other folders are read-only.
- **Markdown adapter (B).** A pure function: `[{ path, text, lastModified }]` → `{ entries, documents }`.
  - `- [ ] text` → `kind: "todo"`, `title` the task text (cut to 120), `next` the task text, `context` the file path and nearest heading, `result: "open"`, `date` a date written in the task line or else the file's date, `topic` a slug of the top folder (or the file name). Obsidian's `📅 2026-11-10` and `due:: 2026-11-10` are read as deadlines (`src/memory/due.js`).
  - `- [x]` is skipped. Hidden folders (`.obsidian/`, `.trash/`) and non-`.md` files are skipped.
  - Each file becomes a document for `recall`, as `notes/` files do today.
- **Paste adapter (C).** A memory node: the pasted text, redacted, goes to plain Muse Spark (`privateSettings`) with a prompt that asks for entries in the entry format: commitments with deadlines as `todo` with `next`, projects and goals as `fact` or `decision`, preferences as `preference`. Parsed with `distill.js`'s parser, validated with `makeEntry`; entries that fail validation are dropped and counted. Settings shows what will be sent before the call. Capped (characters per paste, entries per paste).
- **Settings (D).** A "Memory sources" card: the brain folder, Markdown folders, pasted memories, each with its counts, Sync (folders) and Remove. The import flow then clears cached verdicts and runs the task node (#29), as a brain sync does.
- **Task node (#29).** A `todo` from a Markdown checkbox is a task by construction: it is listed without a model call; only "still open" can be changed by Done.
- **Not touched:** `src/attention/` (İrem's engine work in progress). In `src/background/index.js` only the import and sync handlers change. Memory tests go in `test/browser/run.mjs`, not `extension.mjs`, and `package.json` is unchanged.

## Privacy
- Imported content never enters the repo; fixtures use an invented vault in `test/fixtures/`.
- Folder contents stay on the device. They reach a model only the way brain notes already do: redacted, at most 5 per page decision (`notesFor`), and through the task node.
- The paste is sent once, redacted, to plain Muse Spark, after the person sees it.

## Done when
- [x] Connecting a Markdown folder with `- [ ]` tasks lists them in the task queue (Settings' tasks and the greeting read it), with no model call (browser test on the invented vault; the greeting and `contextPack` themselves are not asserted).
- [x] A pasted assistant memory produces entries with `origin` set, shown as one source in Settings and removable as a group (browser test with a fake model; the Settings clicks are not driven by a test).
- [x] A brain sync leaves the other sources as they are; removing a source leaves the others.
- [x] Unit tests for the Markdown adapter and the paste parser on invented data; `npm test`, `npm run test:browser` and `npm run test:e2e` pass.

## Order
A first (everything depends on it). B and C are pure modules written alongside A, then wired in with D once A is in.
- *Changed while building:* Settings keeps the Brain card as it is and adds an "Other memory" card for folders and pastes, rather than folding the brain into one list: the brain is the one source that is also written to. A pasted entry takes the earliest date its own text names, as a Markdown task does, so a deadline already missed still reads as one. The worker's `sync-brain` also re-reads every connected folder.

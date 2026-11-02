# Tuck knows whose turn it is: Muse Code status in the engine

Status: open

Issue: #11

## Intent
Serves: `docs/INTENT.md` § Outcome. While a coding agent works, a person often waits in the browser. Tuck treats that as drift, and cannot say when the agent has stopped and needs them.

**Conflict to settle in this work:** `docs/INTENT.md` lists the Muse Code connection as a non-goal, says "no separate backend", and says the product does not monitor outside the browser. `AGENTS.md` repeats the last. This change makes a small local exception: agent status only, never terminal content. Update both, and `docs/DECISIONS.md`, in the first commit.

Out of scope: reading terminal output, sending agent messages to a model, approving from the browser, other agents, bringing the terminal to the front.

## Design

### Checked on Muse Code 1.4.14-R7309.1 (macOS, 2026-11-01)

| Situation | Hooks seen |
|---|---|
| A prompt starts | `UserPromptSubmit` |
| A tool runs | `PreToolUse`, `PostToolUse`, `PostToolBatch` |
| Approval needed, headless with `--approval-mode untrusted --approval-judge off` | `PermissionRequest`, then about 6 s later `Notification` with `notification_type: permission_prompt` and "waiting for approval" |
| The turn ends | `Stop` with `last_assistant_message` |
| A question in plain text | `Stop`; the message is the question |

Internal reminder subagents fire hooks with their own `session_id`, some after `Stop`.

The answer is shown after `Stop`, once those are done: 3.2 s and 5.9 s later in two timed headless runs. The host therefore holds a turn's end until the hooks go quiet (`settle` in `bridge/status.mjs`).

Not seen: approval in an interactive session, the event after an approval is answered, `StopFailure`, `request_user_input` (asked for it headless; the agent wrote the question as text).

Default sessions use an approval judge, so few approvals may reach the person. `Stop` is likely the common "your turn".

### Flow

```text
Muse hook -> tuck-hook (script) -> ~/.tuck/agent.jsonl -> host (native messaging) -> extension -> engine
```

- **`tuck-hook`:** gets the hook's JSON on stdin and appends `{ts, session, status, asks}`. It never writes prompts or messages. `asks` is whether the last message ends in a question mark, worked out in the script, so no text leaves it. It always exits 0, quickly: it must never slow or block the agent.
- **Host:** a small Node script Chrome starts through native messaging. It follows the file and passes lines on. An open connection keeps the service worker alive (Chrome's docs). A file between them means the hook needs nothing running.
- **Status:**

| Event, from the session of the latest `UserPromptSubmit` | Status |
|---|---|
| `UserPromptSubmit`, `PostToolUse` | `working` |
| `PermissionRequest`, `Notification` with `permission_prompt` | `waiting_for_user` |
| `Stop` with `asks` | `waiting_for_user` |
| `Stop` | `completed` |
| `StopFailure` | `failed` |
| `SessionEnd`, or nothing for a while | `unknown` |

- **Engine:** a new logged `agent` input. While `working`, unrelated time does not grow the budget. On `waiting_for_user`, `completed` or `failed`, one `agent` trigger, immediate like `return`; then drift counts as usual. `unknown` behaves exactly as today.
- **Words:** templates in `src/tuck/voice.js`: "Muse is waiting on you." and "Muse is done." Answers: Got it, 5-min break. Tuck cannot bring a terminal to the front, so "Take me back" would mislead. A stop while the browser is away is said on return.
- **Install:** `node bridge/install.mjs <project>` writes the native messaging manifest, and `<project>/.muse/hooks.json`, merging with what is there. The manifest needs a fixed extension id, so `src/manifest.json` gains a `key`, which changes the id of an already loaded copy.

Flagged concerns:
- A chat with the agent's question open in the terminal is outside the browser: Tuck only speaks while the browser is in front.
- `Notification` comes about 6 s after `PermissionRequest`. Using both means the first one wins and the second changes nothing.
- A crash sends nothing. The timeout to `unknown` covers it.
- Project hooks need the folder trusted, and third-party reports disagree on hooks inline in `settings.json`, so this uses the project file.

## Plan

| # | Build | You can see |
|---|---|---|
| 1 | `agent` input and trigger, words, docs conflict settled | Replay: no drift while working, one word when it is your turn |
| 2 | `tuck-hook` and status mapping | Run Muse: the file shows the right statuses, with no text |
| 3 | Host, install, extension connection | Tuck speaks when Muse stops, in the real browser |

## Test plan

Tier: unit, replay and integration.

New cases:
- Unit, engine: no budget while `working`; one word on each stop, none repeated; `unknown` matches `main`; subagent events ignored; a timeout falls back to `unknown`.
- Unit, hook: each event maps to its status; the output holds no prompt or message text; bad input exits 0.
- Integration: e2e feeds `agent` inputs through a message; a manual run with real Muse.

Evals: none. No prompt changes.

Done when: `npm test`, `npm run test:browser` and `npm run test:e2e` pass, and a real Muse session makes Tuck speak when it stops.

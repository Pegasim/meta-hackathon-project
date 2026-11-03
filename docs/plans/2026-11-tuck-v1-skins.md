# Tuck v1: skins, a border collie, and a bubble that matches — Implementation Plan

Status: open

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tuck's look becomes a switchable skin in one canonical folder form; the border collie (v1) becomes the default with seven poses driven by real state; Tuck can be tucked away; the bubble, popup and toolbar icon take the skin's colours and icons.

**Architecture:** A skin is a folder `src/tuck/skins/<id>/` with `skin.json`, art and icons. `src/tuck/skins.js` (pure) resolves poses, fallbacks and theme variables; the background loads the chosen skin and sends it with every view, as it sends `tuck.svg` today; the overlay only sets `data-pose`/`data-item` and CSS variables. `present.js` returns a canonical `pose` instead of a paper state name.

**Tech Stack:** plain JS ES modules, Chrome MV3, `node:test`, Playwright (browser tier).

**Spec:** `docs/superpowers/specs/2026-11-04-tuck-v1-skins-design.md` (prototype: `docs/superpowers/specs/2026-11-04-tuck-v1-prototype.html`).

## Intent
Serves: `docs/INTENT.md` § Outcome ("a buddy sitting next to you, not a blocker"), invariants "never punish, never block" and "no moralising".
Change: everything in the spec, in one step (İrem).
Out of scope: pixel art, walking/running, sound, new agent states, engine/trigger/model changes (spec § Non-goals).
Open questions: none.

## Global Constraints

- Canonical poses, exactly: `rest`, `work`, `wait`, `drift`, `happy`, `sleep`, `hello`.
- Theme tokens, exactly: `accent`, `onAccent`, `surface`, `ink`, `muted`, `outline`, `pink` per mode (`light`, `dark`), plus `rim`; CSS variables `--tk-accent`, `--tk-on-accent`, `--tk-surface`, `--tk-ink`, `--tk-muted`, `--tk-outline`, `--tk-pink`, `--tk-rim`.
- v1 colours: body `#222`, white `#fff`, pink `#e98a95`, accent `#94BFAE`, onAccent `#1f2a26`; light surface `#FBF8F2`, ink `#222222`, muted `#5f5a57`, outline `#E3DDD3`; dark surface `#26232a`, ink `#F3EFE8`, muted `#B5AFA8`, outline `#3C3841`; rim `#FFFFFF`.
- Contrast: `ink` on `surface` and `onAccent` on `accent` ≥ 4.5:1 in both modes.
- Only `work` may loop, plus an eye-only `blink` keyframe; everything stops under `prefers-reduced-motion: reduce` and `data-motion="off"`.
- Storage keys: `tuckSkin` (default `"v1"`), `tuckItem` (default `"bandana"`), `tuckAway` (boolean), all in `chrome.storage.local`.
- Every skin's root `<svg>` carries class `tuck` (the overlay and tests select `svg.tuck`).
- No build step; no new dependencies. `src/memory/` untouched. Words in bubbles unchanged (`voice.js`).
- Tests are never weakened. Where an e2e assertion names an old paper state (`checkin`, `resting`, `thinking`), it changes to the spec's canonical pose for that moment, and the commit message says it follows the spec's pose table.

## Review Focus

1. **Service worker restarts during a break or while the agent works** → the next page still shows `sleep` / `work`, because presence derives the pose from engine state, not from memory of the last view. Test in Task 4.
2. **Skin changed while a nudge bubble is open** → the bubble and its buttons stay; only the art and colours change. Test in Task 7.
3. **Reduced motion** → `work` shows its pose without the ear flick or tail sway. Covered by the skin check (Task 1) on every skin's CSS.
4. **Tuck away, then a new day** → session start clears `tuckAway` and Tuck rests on pages again. Test in Task 5.
5. **Away, and the agent word meets a page Tuck cannot draw on** → the held-word path (`sayHeldAgentWord`) still delivers it once on the next drawable page, and Tuck leaves after the answer. Test in Task 5.

---

### Task 1: Skin folder form, the pure skin module, and the skin check (paper moves in)

**Files:**
- Create: `src/tuck/skins.js`, `src/tuck/skins/index.json`, `src/tuck/skins/paper/skin.json`, `src/tuck/skins/README.md`
- Move (git mv): `src/tuck/assets/tuck.svg` → `src/tuck/skins/paper/tuck.svg`, `src/tuck/assets/tuck.css` → `src/tuck/skins/paper/tuck.css`; copy `src/shared/icons/icon-{16,32,48,128}.png` → `src/tuck/skins/paper/icons/{16,32,48,128}.png`; delete `src/tuck/assets/README.md` (its content goes into the new README)
- Modify: `src/background/index.js` (`assets()`, ~line 718), `src/popup/popup.html:7`, `src/popup/popup.js` (`renderMark`)
- Test: `test/unit/tuck/skins.test.js`

**Interfaces:**
- Produces (in `src/tuck/skins.js`):
  - `export const POSES = ["rest","work","wait","drift","happy","sleep","hello"]`
  - `export const THEME_TOKENS = ["accent","onAccent","surface","ink","muted","outline","pink"]`
  - `export function poseAttrs(manifest, pose) → { "data-pose": pose, [manifest.stateAttr]?: string }` — the attributes to set on the root svg; with `stateAttr` set, its value is `manifest.fallback[pose] ?? pose`; without it, a pose missing from `manifest.poses` becomes `manifest.fallback[pose]` in `data-pose`.
  - `export function themeCss(theme) → string` — `:host{--tk-…}` for light and the same under `@media (prefers-color-scheme: dark)`, plus `--tk-rim`.
  - `export function contrast(hexA, hexB) → number` (WCAG ratio).
  - `export function checkSkin(manifest, files) → string[]` — problems, empty when fine. `files`: `{ [relativePath]: string | Buffer }`.
- Paper's `skin.json`: `kind: "svg"`, `size {64,64}`, `poses: []`, `stateAttr: "data-state"`, `fallback {rest:"resting", work:"resting", wait:"checkin", drift:"checkin", happy:"welcome", sleep:"sleeping", hello:"checkin"}`, `items ["none"]`, theme = today's bubble colours (accent `#94BFAE`, onAccent `#1f2a26`, light surface `#ffffff`, ink `#24262d`, muted `#65616d`, outline `#dfe3e8`; dark surface `#24262d`, ink `#eceef1`, muted `#a9adb6`, outline `#3a3d46`; pink `#e98a95`; rim `#FFFFFF`).
- Background `assets()` becomes `assets(id)` → `{ manifest, svg, css }` read from `tuck/skins/<id>/`, cached per id. For this task it is always called with `"paper"`.

- [ ] **Step 1: Write the failing tests** in `test/unit/tuck/skins.test.js`:
  - `every skin in index.json passes checkSkin` — reads `src/tuck/skins/index.json`, each folder's files with `fs`, asserts `checkSkin(...)` deep-equals `[]`.
  - `checkSkin reports a missing pose without fallback` — manifest with `poses: ["rest"]`, `fallback: {}` → result includes `"pose work has no art and no fallback"`.
  - `checkSkin reports a loop outside work` — css `.tuck[data-pose="rest"] .tail{animation:sway 3s infinite}` → includes `"infinite animation outside work: sway"`; while `@keyframes tuck-blink` used with `infinite` → no problem.
  - `checkSkin requires a reduced-motion rule` and `four icons`, and `contrast below 4.5` (`ink "#999999"` on `surface "#ffffff"` → `"light ink on surface 2.8:1"` style message containing `"ink on surface"`).
  - `poseAttrs` on paper's manifest for `drift` → `{ "data-pose": "drift", "data-state": "checkin" }`.
  - `contrast("#222222", "#FBF8F2")` > 4.5.
- [ ] **Step 2: Run** `node --test test/unit/tuck/skins.test.js` — expect FAIL (module missing).
- [ ] **Step 3: Implement `src/tuck/skins.js`, the paper folder and `index.json` (`["paper"]`).** The infinite-loop rule reads each `animation` declaration with `infinite`, and passes it when its selector contains `[data-pose="work"]` or its keyframe name contains `blink`. Write `src/tuck/skins/README.md`: the folder form and manifest fields from the spec, then the six-step "adding an asset" procedure from the spec verbatim, ending with the command `node --test test/unit/tuck/skins.test.js`.
- [ ] **Step 4: Point the background and popup at `tuck/skins/paper/`.** Popup stylesheet link and `renderMark` fetch the paper files; `renderMark` sets the pose through `poseAttrs` (`sleep` on break/paused, else `rest`).
- [ ] **Step 5: Run** `npm test && npm run test:browser && npm run test:e2e` — expect all green, unchanged behaviour.
- [ ] **Step 6: Commit** `feat(tuck): skins live in one folder form, checked by a test` (body: paper moved, no behaviour change).

### Task 2: The v1 border collie skin

**Files:**
- Create: `src/tuck/skins/v1/skin.json`, `src/tuck/skins/v1/tuck.svg`, `src/tuck/skins/v1/tuck.css`, `src/tuck/skins/v1/icons/{16,32,48,128}.png`
- Modify: `src/tuck/skins/index.json` → `["v1","paper"]`
- Test: covered by `test/unit/tuck/skins.test.js` (Task 1)

**Interfaces:**
- Consumes: `checkSkin` (Task 1).
- Produces: `v1` manifest: `kind "svg"`, `size {width:72, height:60}`, all seven poses, `fallback {}`, `items ["none","bandana","frisbee","both"]`, theme from Global Constraints.

- [ ] **Step 1: Turn the prototype into a static SVG + CSS.** Take the markup the prototype's `pet()` builds (lying, sitting, curled bodies; head with floppy ears, eyes, mouths; bandana; frisbee) as one static `<svg class="tuck" viewBox="0 0 120 100">` with `data-pose="rest" data-item="none"`. Map the prototype's `data-x`/`data-pose` pairs to canonical poses: `rest=rest/lie`, `work=work/lie`, `wait=alert/sit`, `drift=curious/lie`, `happy=happy/lie`, `sleep=sleep/curl`, `hello=rest-face/sit`. Rewrite the prototype CSS selectors onto `[data-pose=…]` and `[data-item=…]`, keeping every shape, transform, timing, the 60 ms ear delay, the bandana-hidden-when-curled rule, and the `happy` wag (3 iterations). Add the rim: `.tuck { filter: drop-shadow(0 0 .6px var(--tk-rim, #fff)); }`. Add `@media (prefers-reduced-motion: reduce)` and `[data-motion="off"]` rules that stop all animation and transition.
- [ ] **Step 2: Render the four icons** from the `rest` pose's head (crop to the head, transparent background) with a one-off Playwright snippet kept outside the repo; commit only the PNGs.
- [ ] **Step 3: Run** `node --test test/unit/tuck/skins.test.js` — expect PASS for both skins.
- [ ] **Step 4: Check by eye**: open the SVG in Chromium at 360px and 72px for each of the seven poses and compare with the prototype; fix differences.
- [ ] **Step 5: Commit** `feat(tuck): the border collie skin, seven poses`.

### Task 3: `present.js` speaks in canonical poses

**Files:**
- Modify: `src/tuck/present.js`
- Test: `test/unit/tuck/present.test.js`

**Interfaces:**
- Produces: every view returns `pose` (one of `POSES`) instead of `tuck`; `settle` is a pose. `present({ event: "presence", agent })` takes the engine's agent status; new event `"break"`; new event `"back"` (answered "Take me back").

- [ ] **Step 1: Update the tests to the spec's pose table** (each old `v.tuck` assertion becomes `v.pose`):
  - drift L1 (sure and unsure) and L2/L3 → `"drift"`; fragmentation → `"drift"`.
  - `return`, `break_over`, `session_start`, `card` (with and without intent), `goal_done` → `"hello"`.
  - `agent` trigger → `"wait"`.
  - `goal_set`, `resolved`, `back` → `pose "happy"`, `settle "rest"`.
  - `presence` with `agent: "working"` → `"work"`; with `null`, `"unknown"`, `"waiting_for_user"` → `"rest"`; both `quiet: true`, `bubble: null`.
  - `break` → `{ pose: "sleep", bubble: null, quiet: true }`.
  - Bubble texts and buttons in every existing test stay as they are.
- [ ] **Step 2: Run** `node --test test/unit/tuck/present.test.js` — expect FAIL on `pose`.
- [ ] **Step 3: Implement** the mapping in `present.js`; keep the trigger/bubble logic as it is.
- [ ] **Step 4: Run** `node --test test/unit/tuck/present.test.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(tuck): views name a canonical pose` (Task 4 makes the overlay read it; until then `npm run test:e2e` is expected to fail — do not merge between Task 3 and 4, or fold them into one commit if reviewing separately is not needed).

### Task 4: The overlay draws any skin; the background picks one and sends real state

**Files:**
- Modify: `src/tuck/overlay.js`, `src/background/index.js` (`assets`, `showTuck`, `presence`, `respond`, `process` near line 160, `greet`), `test/browser/extension.mjs`
- Test: `test/browser/extension.mjs`

**Interfaces:**
- Consumes: `poseAttrs`, `themeCss` (Task 1); `present` poses (Task 3).
- Produces: message `tuck-show` carries `{ view, assets: { manifest, svg, css, item } }`; overlay `setPose(pose)` replaces `setState`; dock size = `manifest.size` (the 72×72 `SIZE` constant becomes the skin's size; `layout.js` already takes a size).

- [ ] **Step 1: Change the e2e expectations to poses** (spec pose table), in `test/browser/extension.mjs`: read `svg.tuck` `data-pose` instead of `data-state`; greeting `"hello"`; after Start `"rest"` (after the 1.4 s settle); click `"hello"`; reload `{ state: "rest", … }`; on the video the first word `"drift"`, and the L2 wait loop waits for the bubble text to change to the L2 line instead of for `thinking`. Add: start a break from the nudge → the tab keeps `#tuck-companion` with `data-pose="sleep"`; send agent status `working` (the test already feeds bridge statuses near line 724) → current tab's pose becomes `"work"` with no bubble; `waiting_for_user` → `"wait"` with the bubble. Review Focus 1: during the break, stop the service worker (the test's existing worker handle; `chrome.runtime.reload` is not used) and open a new page → it shows `"sleep"`; same with agent `working` → `"work"`.
- [ ] **Step 2: Run** `npm run test:e2e` — expect FAIL on the new expectations.
- [ ] **Step 3: Overlay.** `ensureRoot` takes the skin: inline `svg`, style = `css + themeCss(manifest.theme) + STYLE`; `setPose` sets the attributes from `poseAttrs` plus `data-item` and replays finite animations (as `setState` does); `closeBubble` and `tuck-rest` set `"rest"`; a new skin arriving (different `manifest.id`) replaces the art in place and keeps the bubble. `skins.js` is a module, the overlay is a classic script: inject `poseAttrs`/`themeCss` the way `layout.js` is injected (a classic script defining `globalThis.tuckSkins`, generated from the same source by re-exporting — keep one source of truth: make `src/tuck/skins.js` assign `globalThis.tuckSkins` when loaded as a classic script and export for node, following `layout.js`'s pattern).
- [ ] **Step 4: Background.** `assets()` reads `tuckSkin` (default `"v1"`) and `tuckItem` (default `"bandana"`). `presence` passes `agent: s.agent?.status` and shows `present({ event: "break" })` on break instead of hiding (paused still hides). In `process`, when the agent status changes (`input.type === "agent"`) and nothing is on screen with a bubble, re-show presence on `tuckTab` quietly. `respond`: `back` → `present({ event: "back" })` then `takeMeBack`; `break` → `present({ event: "break" })` instead of `hideTuck()`; `dismiss` → `restTuck()`.
- [ ] **Step 5: Run** `npm test && npm run test:browser && npm run test:e2e` — expect PASS.
- [ ] **Step 6: Commit** `feat(tuck): the border collie on every page, posed by what is happening` (body notes the e2e state names changed to the spec's poses).

### Task 5: Tuck away

**Files:**
- Create: none
- Modify: `src/tuck/present.js` (gate), `src/tuck/overlay.js` (button in the card), `src/background/index.js` (`showTrigger`, `presence`, `respond`, `greet`, `sayHeldAgentWord`), `src/popup/popup.html`, `src/popup/popup.js`
- Test: `test/unit/tuck/present.test.js`, `test/browser/extension.mjs`

**Interfaces:**
- Produces: `export function comesWhileAway(kind) → boolean` in `present.js`: true for `"drift"`, `"fragmentation"`, `"agent"`, `"session_start"`; false for everything else. Overlay message `tuck-away` (from the card's "Tuck away" button) → background sets `tuckAway: true` and hides Tuck. Popup checkbox `#show-tuck` "Show Tuck on pages" bound to `!tuckAway`.

- [ ] **Step 1: Write the failing tests.** Unit: `comesWhileAway` for each of the four true kinds and for `return`, `break_over`, `checkin`. E2E: click Tuck → card has a button `Tuck away` → click → `#tuck-companion .dock.in` count 0 on this and the next page; force a drift → Tuck comes with the drift bubble; answer `back` → Tuck gone again; send agent `waiting_for_user` → bubble comes, `Got it` → gone; popup `#show-tuck` checked → Tuck rests on the next page; simulate a new day's session start (the test's existing clock/greeting path) → `tuckAway` is false. Review Focus 5: while away, send agent `waiting_for_user` with a `chrome://newtab` tab in front → no bubble there; switch to a normal page → the agent bubble appears once; `Got it` → gone, and a further page shows no Tuck.
- [ ] **Step 2: Run** the unit and e2e tests — expect FAIL.
- [ ] **Step 3: Implement.** One gate in `showTrigger`: when `tuckAway` and `!comesWhileAway(t.kind)`, log and return without showing (reminders that rode along wait, `showWithReminder` is not called). `presence` does nothing while away. After any `respond` while away → `hideTuck()` instead of rest/happy. `greet` clears `tuckAway` before showing. The card's button is a small text button after Done/Change, label `Tuck away`.
- [ ] **Step 4: Run** `npm test && npm run test:e2e` — expect PASS.
- [ ] **Step 5: Commit** `feat(tuck): tuck Tuck away; it comes back only to say something`.

### Task 6: The bubble and popup take the skin's look

**Files:**
- Modify: `src/tuck/overlay.js` (`STYLE`, bubble tail), `src/popup/popup.html`, `src/popup/popup.js`
- Test: `test/browser/extension.mjs` (screenshots already taken when `shots` is set)

**Interfaces:**
- Consumes: `themeCss` (Task 1), `placement()` side (existing).

- [ ] **Step 1: Write the failing test** in `test/browser/extension.mjs`: computed `background-color` of `.bubble` equals the skin's light `surface` (`rgb(251, 248, 242)` for v1), the primary button's background equals `accent` (`rgb(148, 191, 174)`), and the bubble CSS text contains no hex literal (read the shadow root's style text, assert `!/#[0-9a-f]{3,6}\b/i` outside the `--tk-` declarations).
- [ ] **Step 2: Run** `npm run test:e2e` — expect FAIL.
- [ ] **Step 3: Restyle `STYLE`** with only `var(--tk-…)`: surface, ink, 1px outline, radius 16, one shadow, a tail on the side from `dock[data-side]`/`data-vertical` pointing at Tuck; font stack `ui-rounded, system-ui, -apple-system, sans-serif`; message 14px/1.4 weight 600, everything else 13px 400; primary button filled accent with onAccent text; others outlined, hover border accent; focus ring 2px accent with 1px offset; × top right. Popup: header shows the chosen skin (same `assets` path via a `get-skin` message to the background), and `ui.css` colours for the popup body take the same variables.
- [ ] **Step 4: Run** `npm run test:e2e` with screenshots on; check `tuck-greeting.png`, `tuck-nudge.png`, `tuck-reminder.png` against the prototype's palette, light and dark.
- [ ] **Step 5: Commit** `feat(tuck): the bubble wears the skin's colours`.

### Task 7: Choosing the look, and the icons follow

**Files:**
- Modify: `src/options/options.html` (new section "Tuck's look" after "Model"), `src/options/options.js`, `src/background/index.js` (storage listener, `chrome.runtime.onStartup`/`onInstalled`), `src/shared/icons/icon-*.png` (replaced by v1's), `docs/superpowers/specs/2026-10-31-attention-agent-design.md` §12 (addendum line pointing at the new spec)
- Test: `test/browser/extension.mjs`

**Interfaces:**
- Consumes: `src/tuck/skins/index.json`, each `skin.json` (`name`, `items`), `assets(id)`.
- Produces: options controls `#tuck-skin` (select, one option per index entry, label = `name`) and `#tuck-item` (select of the skin's `items`, hidden when only `none`), each saving to `tuckSkin` / `tuckItem` on change, with a live preview of the skin's `rest` pose.

- [ ] **Step 1: Write the failing test**: with a nudge bubble open on a tab, set `#tuck-skin` to `paper` in the options page → the tab's `svg.tuck` gains `data-state` (paper's `stateAttr`) while `.bubble button[data-choice=back]` is still visible; set back to `v1`; set `#tuck-item` to `frisbee` → `svg.tuck[data-item=frisbee]`.
- [ ] **Step 2: Run** `npm run test:e2e` — expect FAIL.
- [ ] **Step 3: Implement.** Background listens to `chrome.storage.onChanged` for `tuckSkin`/`tuckItem`: re-sends the current view to `tuckTab` with the new assets, and calls `chrome.action.setIcon({ path: { 16, 32, 48, 128 } })` with the skin's icon paths; the same `setIcon` runs on `onStartup` and `onInstalled`. Copy v1's icons over `src/shared/icons/icon-*.png` (the manifest icons show the default skin).
- [ ] **Step 4: Run** `npm test && npm run test:browser && npm run test:e2e` — expect PASS.
- [ ] **Step 5: Update** the 2026-10-31 spec §12 with one line: "Superseded for the avatar, poses, presence on breaks and Tuck away by `2026-11-04-tuck-v1-skins-design.md`."
- [ ] **Step 6: Commit** `feat(tuck): pick Tuck's look; the toolbar icon follows`.

## Test plan
Tier: unit (`npm test`) and integration (`npm run test:browser && npm run test:e2e`), because `src/tuck/`, `src/background/`, `src/popup/` and `src/options/` change.
New cases: `test/unit/tuck/skins.test.js` (skin check, pose attrs, contrast); `present.test.js` pose table, `comesWhileAway`; e2e: poses on greeting/rest/click/reload/drift, break → sleep on the page, agent working → work and waiting → wait, Tuck away flow and new-day reset, bubble colours from the theme with no literal colours, skin and item switch with an open bubble.
Evals: none (no prompt or model change).

Done when: `npm test && npm run test:browser && npm run test:e2e` exits 0, and `node --test test/unit/tuck/skins.test.js` reports both `v1` and `paper` passing.

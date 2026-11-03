# Tuck v1: skins, a border collie, and a bubble that matches

Date: 2026-11-04 · Owner: İrem · Branch: `feat-avatar-redesign`
Prototype (open in a browser): [`2026-11-04-tuck-v1-prototype.html`](2026-11-04-tuck-v1-prototype.html)

## Intent

Tuck today is a paper figure whose motion does not say what is going on: a drift, a
break ending, the agent being ready and the start of the day all play the same wave,
and the sleeping pose is never shown on a page. İrem wants a buddy you can read at a
glance, with the bubble, buttons and colours redesigned so the whole thing feels like
one character. A glance at Tuck should answer "is my terminal busy, am I on track, is my
break running", without a bubble.

It serves `docs/INTENT.md` → Outcome ("a buddy sitting next to you, not a blocker") and
the invariants "never punish, never block" and "no moralising". People who drift easily
are the users, so motion is itself a risk: a pet that keeps moving is the distraction
we are fighting.

## Goals

1. **A skin system with one canonical form.** The look of Tuck is a skin. Switching skins
   is a setting. Any new asset İrem brings (SVG or PNG frames) is turned into this form
   by a documented, checked procedure, and the bubble takes its colours from the skin.
2. **Tuck v1**, the border collie in the prototype, as the default skin. Today's paper
   Tuck stays as the skin `paper`.
3. **A pose for every situation** (the table below), driven by the product's real state.
4. **Tuck away:** the person can hide Tuck; it then comes only to say something.
5. **The bubble redesigned** to match the skin.

All five ship together (İrem).

## Non-goals

- Pixel art, or any automatic pixelation of a vector skin. Tried and rejected. Pixel art
  can come later as a hand-made `sprites` skin.
- Walking, running, moving around the page. Tuck stays where the person put it.
- Sound.
- New agent states. Only what the bridge sends today (`working`, `waiting_for_user`,
  `completed`, `failed`, `unknown`).
- Changes to timing, triggers, the engine or the model calls.

## Anti-goals (failure even if it works)

- **Motion that pulls the eye.** Only one state moves continuously (agent working), and
  only a little. Everything else moves once, on entering the state, then holds still.
- **Love tied to performance.** Tuck is never sad, sulky or disappointed: not when a
  nudge is dismissed, not when it is hidden, not when the person does not work.
- **A bubble that looks like a different product** from the character next to it.
- **A skin that can only be added by editing overlay code.**

## The character (decided with İrem)

Flat vector, near-black body (`#222`), white blaze, muzzle, ruff, paws and tail tip.
Round eyes: white with a big dark pupil and one shine. A small ω mouth that changes
with the mood; pink (`#e98a95`) only for the tongue, the inside of the ears and the toe
beans. Floppy dog ears with pink inside that lift with the mood. No neck showing:
the head sits on the body. Pose changes are eased transforms of the same parts (head,
ears, eyes, mouth, paw, tail), never a redraw: one sine-like ease, about 0.5 s; the
second ear trails the first by 60 ms. Items in the accent mint `#94BFAE`: a bandana
(part of the head, hidden while curled asleep) and a frisbee on the ground.
The prototype file is the reference for shapes, poses, timings and the item rule.

The body always has a thin light rim (`theme.rim`), so it does not disappear on a dark
page; on a light page the rim is invisible. Always on, because the overlay reads
nothing from the page and cannot know the page's colour (Claude's call).

## Poses and when they show

Seven canonical poses. Each skin implements them, or names a fallback for each one it
lacks.

| Pose | Looks like | Moves | Shown when |
|---|---|---|---|
| `rest` | lying, chin down, ears loose, slow blink | blink only | a goal is set, nothing else is going on |
| `work` | lying, head up, ears up, eyes to the side (on the terminal) | ear flick now and then, slow tail sway; **the only continuous motion** | the coding agent's status is `working` |
| `wait` | sits up, lifts a front paw (pink beans show), small open smile | once on entry | agent `waiting_for_user`, `completed` or `failed` (the existing `agent` trigger) |
| `drift` | lifts and tilts head, one ear up, one down, little "oh?" | once | drift (any level), fragmentation |
| `happy` | crescent eyes, open smile, three quick tail wags | once, then settles to `rest` | goal set, "This is for my task", back at work by themselves (`resolved`), "Take me back" |
| `sleep` | curled up, eyes closed, ears down | none | on a break (the whole break) |
| `hello` | sits facing you | once | session start / goal form, the goal card (click on Tuck), break over, `return`, goal done |

Dismissing a nudge (× or "Got it") goes straight to `rest`, without `happy`.

Changes from today's behaviour (spec addendum §12, design doc 2026-10-31):

- During a break Tuck stays on the page asleep instead of leaving. Paused (DND, Off)
  still hides it.
- Presence is no longer always `resting`: the resting pose follows the agent status, so
  when the agent starts or stops working the Tuck on the current page changes pose
  quietly (no bubble, no entrance) and back.

## Tuck away

- One click hides Tuck: a small "Tuck away" text button in the goal card (click on Tuck),
  and a "Show Tuck on pages" switch in the popup to bring it back. No confirmation.
- Stored as `tuckAway: true` in `chrome.storage.local`. It clears itself at the day's
  session start, so a new day starts with Tuck visible (Claude's call, İrem agreed in
  chat).
- While away, Tuck does not rest on pages and does not sleep through breaks. It still
  comes for a **drift** nudge (fragmentation counts as drift) and for an **agent** word
  (both İrem's decision), plays the pose, says it, and after any answer or dismissal
  leaves again instead of resting. The session-start goal form also still comes
  (Claude's call: without a goal nothing else works). Nothing else comes while away:
  not `return`, not `break_over`, not the goal form after `goal_done`; a to-do reminder
  that would ride on one of those waits for the next visible moment (Claude's call,
  from İrem's "only when the agent waits or something goes wrong"). Gate it in one
  place in the background, by trigger kind. The goal card cannot be opened while away
  (there is no Tuck to click); the popup is the way back.
- Coming back is never framed as a reproach.

## The skin system (canonical form)

A skin is one folder: `src/tuck/skins/<id>/`. Nothing about a skin lives in the overlay,
the background or the popup; they only read the folder.

```
src/tuck/skins/<id>/
  skin.json      the manifest (required)
  tuck.svg       kind "svg": the art, one inline SVG
  tuck.css       kind "svg": the poses, as CSS on data attributes
  frames/*.png   kind "sprites": one horizontal strip per pose
  icons/16.png   toolbar and extension icons, also 32.png, 48.png, 128.png (required)
```

`skin.json`:

```json
{
  "id": "v1",
  "name": "Border collie",
  "kind": "svg",
  "size": { "width": 72, "height": 60 },
  "poses": ["rest", "work", "wait", "drift", "happy", "sleep", "hello"],
  "fallback": {},
  "items": ["none", "bandana", "frisbee", "both"],
  "theme": {
    "light": { "accent": "#94BFAE", "onAccent": "#1f2a26", "surface": "#FBF8F2",
               "ink": "#222222", "muted": "#5f5a57", "outline": "#E3DDD3", "pink": "#e98a95" },
    "dark":  { "accent": "#94BFAE", "onAccent": "#1f2a26", "surface": "#26232a",
               "ink": "#F3EFE8", "muted": "#B5AFA8", "outline": "#3C3841", "pink": "#e98a95" },
    "rim": "#FFFFFF"
  }
}
```

The contract between a skin and the page:

- **SVG skins.** The overlay inlines `tuck.svg` and sets `data-pose`, `data-item` and,
  when motion is off, `data-motion="off"` on the root `<svg>`. All motion is in
  `tuck.css`, keyed on those attributes; it must stop under
  `prefers-reduced-motion: reduce` and `data-motion="off"` while keeping the poses.
  Finite effects play on entering a pose; the overlay replays them when the same pose
  is set again (as `setState` does today).
- **Sprite skins.** Per pose: `frames/<pose>.png`, a horizontal strip of equal frames,
  plus in the manifest `"frames": { "<pose>": { "count": 4, "fps": 6, "loop": false } }`
  and the frame size. The overlay shows the strip as a background with CSS `steps()`;
  `loop: true` is allowed only for `work`. Pixel art is drawn with
  `image-rendering: pixelated` at a whole-number scale.
- **Fallback.** A skin missing a pose maps it in `fallback`, e.g. `paper` maps
  `work → resting`, `wait → checkin`, `drift → checkin`, `happy → welcome`,
  `sleep → sleeping`, `hello → checkin`, `rest → resting` (its own state names, via an
  extra `"stateAttr": "data-state"` so the old art keeps working unchanged).
- **Theme.** The overlay and the popup set the theme as CSS custom properties
  (`--tk-accent`, `--tk-on-accent`, `--tk-surface`, `--tk-ink`, `--tk-muted`,
  `--tk-outline`, `--tk-pink`, `--tk-rim`) on their root, light or dark by
  `prefers-color-scheme`. The bubble's CSS uses only these variables, no literal colours.
- **Items.** Optional. A skin that has none lists `["none"]`.
- **Icons (İrem).** Every skin brings its own icons (`icons/16|32|48|128.png`, the
  `rest` pose's head on a transparent background). Choosing a skin sets the toolbar
  icon with `chrome.action.setIcon`, at once and again when the service worker starts.
  The icon on `chrome://extensions` and the Web Store comes from `manifest.json` and
  cannot change at run time: it shows the default skin's icons, copied to
  `src/shared/icons/`. The badge keeps working on top of any skin's icon.

**Choosing a skin.** Options page, a "Tuck's look" picker listing the skins from a
generated index, with a live preview; the item picker sits next to it when the skin has
items. Stored as `tuckSkin` and `tuckItem` in `chrome.storage.local`. Defaults:
`v1`, item `bandana` (Claude's call). Changing it updates the Tuck on open pages and the
popup header without a reload. The skin index is a static list in
`src/tuck/skins/index.json` (MV3 cannot list a folder at run time).

**Adding an asset (the procedure for "here is another asset").** Written as
`src/tuck/skins/README.md` (replacing `src/tuck/assets/README.md`):

1. Make the folder and `skin.json`; pick `kind`.
2. Map each canonical pose to the art, or to a fallback.
3. Export the four icon sizes into `icons/`.
4. Read the palette off the art and fill `theme`; `ink` on `surface` and `onAccent` on
   `accent` must pass 4.5:1.
5. Add the id to `index.json`.
6. Run the skin check (below). It must pass before the skin is offered.

**The skin check** (unit tier, `test/unit/tuck/skins.test.js`): for every skin in
`index.json`: the manifest has the required fields; every canonical pose is either in
`poses` or in `fallback`, and fallbacks point at something that exists; SVG skins: the
root is an `<svg>`, and `tuck.css` has a reduced-motion rule; sprite skins: every frame
file exists; every skin has the four icon files at their sizes; the theme has every token in both modes and the two contrast pairs pass
4.5:1; at most one pose loops, and only `work`. The blink is the one exemption: an
eye-only blink may loop in any open-eyed pose (Claude's call; it is in the pose table
and in `paper`). For SVG skins the check reads `tuck.css`: every `infinite` animation
must be under a `[data-pose="work"]` selector or name a keyframe called `blink`
(`paper` matches by its `tuck-blink`).

## The bubble

Restyled to belong to the character, using only the theme variables:

- Surface `--tk-surface` (warm off-white, not pure white), ink `--tk-ink`, hairline
  `--tk-outline`, radius 16, one soft shadow; a small tail pointing at Tuck on the side
  the bubble opens toward (`layout.js` already knows the side).
- Type: the system rounded face first (`ui-rounded`, then `system-ui`) so it feels as
  soft as the character without shipping a font; message 14/1.4 semibold, everything
  else 13 regular (Claude's call).
- Buttons: the primary answer filled `--tk-accent` with `--tk-on-accent` text; the
  others outlined in `--tk-outline`, hover to the accent border; visible focus ring in
  the accent. The × stays, top right.
- Content and words do not change (`present.js` decides them, `voice.js` stays).
- The popup header and the popup's colours use the same variables, so the popup matches
  the chosen skin.

## Constraints

- No build step: plain ES modules and files under `src/`.
- Content scripts are injected (`chrome.scripting`), the overlay lives in its own Shadow
  DOM; skin files are fetched by the background and sent with the view, as today
  (`assets()` in `src/background/index.js`).
- Tuck's box today is 72×72 (`SIZE` in `src/tuck/overlay.js`); v1 is wider than tall, so
  the dock takes its size from the skin manifest.
- `src/memory/` is not touched.
- Tests follow `docs/guides/testing.md`: unit for `present.js` and the skin check,
  browser and e2e because `src/tuck/`, `src/background/` and `src/popup/` change.
- Deadline: Nov 4 2026, 9:00 PM ET.

## Left to the builder

- How `present.js` returns the pose (a new field vs renaming `tuck`), and how the
  agent status reaches presence (the engine snapshot already carries `agent`).
- Turning the prototype into `tuck.svg` + `tuck.css` (static SVG, CSS keyed on
  `data-pose` and `data-item`), keeping its shapes and timings.
- How v1's icons are made (rendered once from the SVG by a small script, or drawn).
- The exact Options and popup layout of the new controls, following the bubble's look.
- Updating the spec addendum (§12 of the 2026-10-31 design) and the Tuck guide text to
  the new behaviour.

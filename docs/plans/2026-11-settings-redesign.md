# Settings and popup redesign

Status: done (#120). Keep / Remove for memory: #121, after the hackathon.

## Intent

Settings was one long column of cards in the default blue, which did not look like
Tuck and made the four things people come for hard to find: change Tuck's look, add
notes, check what Tuck read from them, and fix what it got wrong. The popup used
sharp, outlined buttons that wrapped. Serves `docs/INTENT.md` (one-click correction:
a correction that is hard to find is not one click).

## Design

Agreed in the browser (option B, v3 of the brainstorm mockups):

- Settings opens on **Home**: the skin's avatar with one line saying what to do next
  (set up the model, add notes, or check tasks) and one button for it, and a summary
  card per area with a button into it.
- Round **tabs** across the top: Home, Look, Notes, Check, Privacy, Connections,
  Activity. A tab is the URL hash (`#look`), so a link like
  `options.html#brain-section` opens the tab that holds that element and scrolls to it.
  (The mockup had "More"; it is split into Connections and Activity so no tab is a
  grab bag. My call.)
- **Pause Tuck** is a switch in the header, on every tab.
- The page and the popup wear the skin's colours (as the popup already did), and
  `shared/ui.css` changes to round, solid buttons in three levels: lilac for the one
  main action, a solid tone for the rest, nothing see-through. Cards have no outline;
  they sit on tone steps.
- Colours (from the person, 2026-11-04): the kitten's theme is Parchment / aubergine in
  light (page #E5E0DB, surface #F1EDE6, border #CEC6BD, text #393238, secondary
  #70666B, accent #80668E) and Graphite / muted lilac in dark (#191A1C, #252629,
  #3B3C40, #E7E3DE, #B6B0AA, #B9A6D4). A skin's theme may name a `page` colour.
- Settings → Look → **Theme**: Follow my computer, Light or Dark (`tuckTheme`), for
  Settings, the popup and Tuck on the page.
- Tuck's face in the header and on Home is the first rest frame cut to what is drawn,
  so no part of the kitten is cut off (its icon is drawn to its edges).
- Phosphor duotone icons, inlined as in `src/tuck/icons.js` (extension pages load
  nothing remote). The "Check" tab uses a list-check, not a sparkle.

Not done: Keep / Remove on what Tuck read from the notes. Today a row has Done, Not a
task and Not the same; what "remove" should mean for memory is Safa's call
(`src/memory/`, AGENTS.md rule 2): #121. Until then, Not a task only takes a row off the list.

## Plan

1. `src/shared/ui.css`: tokens and components (buttons, cards, tabs, switch, rows).
2. `src/tuck/skins.js`: `pageThemeCss(theme)`, the popup's theme mapping, shared.
3. `src/options/options.html`: header, tabs, panels; every existing id kept.
4. `src/options/options.js`: tab router, Home summary, skin avatar, theme; "above"
   copy now says "in Connections".
5. `src/popup/popup.html`: rounder layout, Tuck away in the header, buttons that do
   not wrap.
6. Browser tests open the tab they use before clicking in it.

## Test plan

Tier: unit (`npm test`) and integration (`npm run test:browser && npm run test:e2e`).
No new behaviour in the engine or agent, so no eval. The browser tests are updated
only to open the tab that now holds an element, and for the "in Connections" copy.

Done when: `npm test && npm run test:browser && npm run test:e2e` exits 0.

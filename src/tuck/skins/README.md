# Tuck's skins

A skin is one folder: `src/tuck/skins/<id>/`. Nothing about a skin lives in the overlay, the background or the popup; they only read the folder. `index.json` lists the ids offered (MV3 cannot list a folder at run time). `skins.js` holds the pure parts (poses, theme, the check).

```
src/tuck/skins/<id>/
  skin.json      the manifest (required)
  tuck.svg       kind "svg": the art, one inline SVG, root class "tuck"
  tuck.css       kind "svg": the poses, as CSS on data attributes
  frames/*.png   kind "sprites": one horizontal strip per pose
  icons/16.png   toolbar and extension icons, also 32.png, 48.png, 128.png (required)
```

## skin.json

- `id`, `name`, `kind` (`"svg"` or `"sprites"`), `size {width, height}` (the box Tuck takes on the page).
- `poses`: the canonical poses the skin draws: `rest`, `work`, `wait`, `drift`, `happy`, `sleep`, `hello`.
- `fallback`: for a pose the skin does not draw, the pose (or, with `stateAttr`, the state name) to show instead.
- `stateAttr`: optional; an attribute (paper uses `data-state`) that carries the fallback name, so older art keeps working unchanged.
- `items`: optional accessories; a skin without any lists `["none"]`.
- `theme`: `light` and `dark`, each with `accent`, `onAccent`, `surface`, `ink`, `muted`, `outline`, `pink`; plus `rim`. They become `--tk-accent`, `--tk-on-accent`, `--tk-surface`, `--tk-ink`, `--tk-muted`, `--tk-outline`, `--tk-pink`, `--tk-rim`.
- Sprite skins add `frame {width, height}` (one frame's pixels in the strips; `size` is how big Tuck is on screen) and `frames: { "<strip>": { … } }`, one entry per strip in `frames/<strip>.png` (frames side by side):
  - `count` frames, played at `fps`; an entrance plays once (`repeat` times) and holds the first frame.
  - `loop: true` only for `work` (and the `drag-left` / `drag-right` strips, played while the person drags Tuck).
  - `every`: only `rest`, at least 6000 ms: a calm idle (a breath, a blink) that comes back now and then.
  - `gaze: true`: once played, Tuck turns to its bubble, using the optional `look` strip (16 frames, clockwise from up in 22.5° steps).
  - Optional extra strips: `drag-left`, `drag-right`, `look`. The default skin, `kitten`, is the reference (its `source` field says which atlas rows became which strip).

## The contract with the page

- SVG skins: the overlay inlines `tuck.svg` and sets `data-pose` (and `data-item`, and `data-motion="off"` when motion is off) on the root `<svg>`. All motion is in `tuck.css`, keyed on those attributes. Finite effects play on entering a pose.
- Only `work` may loop, plus an eye-only `blink` keyframe. Everything stops under `prefers-reduced-motion: reduce` and `data-motion="off"`, keeping the poses.
- Every skin brings its own icons (the `rest` pose's head on a transparent background).

## Adding an asset

1. Make the folder and `skin.json`; pick `kind`.
2. Map each canonical pose to the art, or to a fallback. A sprite atlas is cut into one strip per pose (crop every cell to the same box so frames line up); keep loops off every pose but `work`.
3. Export the four icon sizes into `icons/`.
4. Read the palette off the art and fill `theme`; `ink` on `surface` and `onAccent` on `accent` must pass 4.5:1.
5. Add the id to `index.json`.
6. Run the skin check (`node --test test/unit/tuck/skins.test.js`). It must pass before the skin is offered.

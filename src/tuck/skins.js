// Tuck's skins: poses, theme and the skin check. A classic script (like layout.js) that
// defines globalThis.tuckSkins; pure, so it is tested in node. The service worker and the
// popup load it with `import "../tuck/skins.js"`, the overlay is injected with it.
globalThis.tuckSkins = (() => {
  const POSES = ["rest", "work", "wait", "drift", "happy", "sleep", "hello"];
  const THEME_TOKENS = ["accent", "onAccent", "surface", "ink", "muted", "outline", "pink"];
  const ICON_SIZES = [16, 32, 48, 128];
  const DEFAULT_SKIN = "kitten";
  // Frame strips a sprite skin may add beyond the poses: running while dragged, and the
  // look directions (16, clockwise from up) Tuck turns to its bubble with.
  const SPRITE_EXTRAS = ["drag-left", "drag-right", "look"];

  // The attributes to set on the skin's root <svg> for a pose.
  function poseAttrs(manifest, pose) {
    const fallback = manifest.fallback?.[pose] ?? pose;
    if (manifest.stateAttr) return { "data-pose": pose, [manifest.stateAttr]: fallback };
    return { "data-pose": manifest.poses?.includes(pose) ? pose : fallback };
  }

  const cssVar = (token) => "--tk-" + token.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  function themeCss(theme) {
    const block = (mode) =>
      ":host{" + [...THEME_TOKENS.map((t) => `${cssVar(t)}:${mode[t]}`), `--tk-rim:${theme.rim}`].join(";") + "}";
    return block(theme.light) + `@media (prefers-color-scheme: dark){${block(theme.dark)}}`;
  }

  function luminance(hex) {
    let h = hex.replace("#", "");
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const [r, g, b] = [0, 2, 4].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(hexA, hexB) {
    const [hi, lo] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  }

  const ANIMATION_WORDS = new Set(
    "linear ease ease-in ease-out ease-in-out step-start step-end infinite none normal reverse alternate alternate-reverse forwards backwards both running paused initial inherit".split(
      " ",
    ),
  );

  // Names of the keyframes that loop forever under a selector that is not the work pose.
  function loopsOutsideWork(css) {
    const found = [];
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const inWork = /\[data-pose=["']?work["']?\]/.test(selector);
      const decls = [...body.matchAll(/(animation(?:-[a-z-]+)?)\s*:\s*([^;]*)/g)];
      const value = (prop) => decls.find((d) => d[1] === prop)?.[2];
      const shorthand = value("animation");
      const looping =
        /\binfinite\b/.test(shorthand ?? "") || /\binfinite\b/.test(value("animation-iteration-count") ?? "");
      if (!looping) continue;
      const names = shorthand
        ? shorthand.split(/[\s,]+/).filter((w) => /^[a-zA-Z_-][\w-]*$/.test(w) && !ANIMATION_WORDS.has(w))
        : (value("animation-name") ?? "").split(/[\s,]+/).filter(Boolean);
      for (const name of names.length ? names : ["(unnamed)"]) {
        if (!inWork && !name.includes("blink")) found.push(name);
      }
    }
    return found;
  }

  // A sprite skin as an <svg class="tuck">: one <image> showing one frame of a strip, so
  // the page, the popup and the tests treat it as any skin. url(name) is a strip's URL.
  function spriteSvg(manifest, url) {
    // frame: one frame's pixels in the strips; size: how big Tuck is on screen.
    const { width: w, height: h } = manifest.frame ?? manifest.size;
    const n = manifest.frames.rest.count;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" class="tuck" viewBox="0 0 ${w} ${h}" ` +
      `width="${manifest.size.width}" height="${manifest.size.height}" ` +
      `data-pose="rest" data-item="none" style="overflow:hidden">` +
      `<image class="tuck__strip" href="${url("rest")}" x="0" y="0" width="${w * n}" height="${h}" ` +
      `preserveAspectRatio="none" style="image-rendering:pixelated"/></svg>`
    );
  }

  // Any skin's files for drawing: { manifest, svg, css }. read(file) gives a file's text,
  // url(file) its URL.
  async function loadSkin(read, url) {
    const manifest = JSON.parse(await read("skin.json"));
    if (manifest.kind === "sprites")
      return { manifest, svg: spriteSvg(manifest, (name) => url(`frames/${name}.png`)), css: "" };
    const [svg, css] = await Promise.all([read("tuck.svg"), read("tuck.css")]);
    return { manifest, svg, css };
  }

  // The problems with a skin, empty when it is fine. files: { "tuck.svg": text, "icons/16.png": … }
  function checkSkin(manifest, files) {
    const problems = [];
    const has = (path) => files[path] !== undefined;
    const text = (path) => String(files[path] ?? "");
    for (const f of ["id", "name", "kind", "size", "poses", "fallback", "items", "theme"]) {
      if (manifest[f] === undefined) problems.push(`manifest has no ${f}`);
    }
    const poses = manifest.poses ?? [];
    const fallback = manifest.fallback ?? {};

    for (const pose of POSES) {
      if (!poses.includes(pose) && fallback[pose] === undefined) {
        problems.push(`pose ${pose} has no art and no fallback`);
      }
    }
    for (const [pose, to] of Object.entries(fallback)) {
      if (manifest.kind === "svg" && manifest.stateAttr) {
        if (!text("tuck.css").includes(`"${to}"`)) problems.push(`fallback ${pose} -> ${to} has no art`);
      } else if (!poses.includes(to)) {
        problems.push(`fallback ${pose} -> ${to} points at a pose the skin lacks`);
      }
    }

    if (manifest.kind === "svg") {
      const root = text("tuck.svg").match(/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(<svg[\s>][^>]*>)/);
      if (!root) problems.push("tuck.svg does not start with an <svg>");
      else if (!/class=["'][^"']*\btuck\b/.test(root[1])) problems.push("root svg has no class tuck");
      const css = text("tuck.css");
      if (!/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/.test(css)) {
        problems.push("tuck.css has no prefers-reduced-motion rule");
      }
      if (!/\[data-motion=["']?off["']?\]/.test(css)) problems.push('tuck.css has no [data-motion="off"] rule');
      for (const name of new Set(loopsOutsideWork(css))) problems.push(`infinite animation outside work: ${name}`);
    } else if (manifest.kind === "sprites") {
      const strips = Object.keys(manifest.frames ?? {}).filter((name) => manifest.frames[name]);
      for (const pose of poses) if (!strips.includes(pose)) problems.push(`pose ${pose} has no frames entry`);
      for (const name of strips) {
        if (!POSES.includes(name) && !SPRITE_EXTRAS.includes(name)) problems.push(`unknown strip ${name}`);
        if (!has(`frames/${name}.png`)) problems.push(`frames/${name}.png is missing`);
        const f = manifest.frames[name];
        if (!(f.count >= 1)) problems.push(`strip ${name} has no count`);
        // Only work moves on its own for good; dragging is the person's own motion.
        if (f.loop && name !== "work" && !name.startsWith("drag-")) problems.push(`pose ${name} loops; only work may`);
        // A calm idle (a breath and a blink) may come back now and then, at most every 6 s.
        if (f.every !== undefined && (name !== "rest" || f.every < 6000))
          problems.push(`strip ${name} repeats every ${f.every} ms; only rest may, at most every 6000`);
      }
    } else {
      problems.push(`unknown kind ${manifest.kind}`);
    }

    for (const size of ICON_SIZES) if (!has(`icons/${size}.png`)) problems.push(`icons/${size}.png is missing`);

    const theme = manifest.theme ?? {};
    if (!theme.rim) problems.push("theme has no rim");
    for (const mode of ["light", "dark"]) {
      const colours = theme[mode] ?? {};
      for (const token of THEME_TOKENS) if (!colours[token]) problems.push(`theme ${mode} has no ${token}`);
      for (const [fg, bg] of [
        ["ink", "surface"],
        ["onAccent", "accent"],
      ]) {
        if (!colours[fg] || !colours[bg]) continue;
        const ratio = contrast(colours[fg], colours[bg]);
        if (ratio < 4.5) problems.push(`${mode} ${fg} on ${bg} ${ratio.toFixed(1)}:1`);
      }
    }
    return problems;
  }

  return { POSES, THEME_TOKENS, DEFAULT_SKIN, poseAttrs, themeCss, contrast, checkSkin, spriteSvg, loadSkin };
})();

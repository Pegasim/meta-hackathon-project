import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// skins.js is a classic script: it defines globalThis.tuckSkins.
await import("../../../src/tuck/skins.js");
const { poseAttrs, contrast, checkSkin } = globalThis.tuckSkins;

const skinsDir = path.resolve(import.meta.dirname, "../../../src/tuck/skins");
function readFolder(dir, prefix = "") {
  const files = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) Object.assign(files, readFolder(path.join(dir, entry.name), `${prefix}${entry.name}/`));
    else files[prefix + entry.name] = fs.readFileSync(path.join(dir, entry.name));
  }
  return files;
}
const paper = JSON.parse(fs.readFileSync(path.join(skinsDir, "paper/skin.json"), "utf8"));

// A small skin that passes, to break one thing at a time.
const icons = Object.fromEntries([16, 32, 48, 128].map((s) => [`icons/${s}.png`, ""]));
const goodCss =
  '@media (prefers-reduced-motion: reduce){.tuck{animation:none}} .tuck[data-motion="off"]{animation:none}';
const skin = (over = {}) => ({
  manifest: {
    id: "x",
    name: "X",
    kind: "svg",
    size: { width: 64, height: 64 },
    poses: ["rest", "work", "wait", "drift", "happy", "sleep", "hello"],
    fallback: {},
    items: ["none"],
    theme: paper.theme,
    ...over.manifest,
  },
  files: { "tuck.svg": '<svg class="tuck"></svg>', "tuck.css": goodCss, ...icons, ...over.files },
});
const check = (over) => {
  const s = skin(over);
  return checkSkin(s.manifest, s.files);
};

test("every skin in index.json passes checkSkin", () => {
  for (const id of JSON.parse(fs.readFileSync(path.join(skinsDir, "index.json"), "utf8"))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(skinsDir, id, "skin.json"), "utf8"));
    assert.deepEqual(checkSkin(manifest, readFolder(path.join(skinsDir, id))), [], id);
  }
});

test("a skin that passes reports nothing", () => assert.deepEqual(check(), []));

test("checkSkin reports a missing pose without fallback", () => {
  assert.ok(check({ manifest: { poses: ["rest"], fallback: {} } }).includes("pose work has no art and no fallback"));
});

test("checkSkin reports a loop outside work", () => {
  const css = goodCss + '.tuck[data-pose="rest"] .tail{animation:sway 3s infinite}';
  assert.ok(check({ files: { "tuck.css": css } }).includes("infinite animation outside work: sway"));
});

test("a loop under work and the eye blink are fine", () => {
  const css =
    goodCss +
    '.tuck[data-pose="work"] .tail{animation:sway 3s infinite}.tuck[data-pose="rest"] .eyes{animation:tuck-blink 9s linear infinite}';
  assert.deepEqual(check({ files: { "tuck.css": css } }), []);
});

test("checkSkin requires a reduced-motion rule", () => {
  assert.ok(check({ files: { "tuck.css": ".tuck{}" } }).some((p) => p.includes("reduced-motion")));
});

test("checkSkin requires the four icons", () => {
  const problems = check({ files: { "icons/48.png": undefined } });
  assert.ok(problems.includes("icons/48.png is missing"));
});

test("checkSkin reports contrast below 4.5", () => {
  const theme = { ...paper.theme, light: { ...paper.theme.light, ink: "#999999", surface: "#ffffff" } };
  assert.ok(check({ manifest: { theme } }).some((p) => p.includes("ink on surface")));
});

test("poseAttrs maps paper's drift to its own state name", () => {
  assert.deepEqual(poseAttrs(paper, "drift"), { "data-pose": "drift", "data-state": "checkin" });
});

test("poseAttrs falls back when a skin lacks the pose", () => {
  const m = { poses: ["rest"], fallback: { work: "rest" } };
  assert.deepEqual(poseAttrs(m, "work"), { "data-pose": "rest" });
  assert.deepEqual(poseAttrs(m, "rest"), { "data-pose": "rest" });
});

test("contrast follows WCAG", () => {
  assert.ok(contrast("#222222", "#FBF8F2") > 4.5);
  assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
});

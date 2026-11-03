// Renders the toolbar icons from src/tuck/skins/paper/tuck.svg (resting pose, cropped to
// the character). Run after changing the artwork: node scripts/make-icons.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.resolve(import.meta.dirname, "..");
const svg = fs
  .readFileSync(path.join(root, "src/tuck/skins/paper/tuck.svg"), "utf8")
  // The body only: crop the viewBox to the character, without the effect area.
  .replace('viewBox="0 0 280 260"', 'viewBox="30 30 200 200"');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}.tuck__effects{display:none}</style>${svg}`,
  );
  await page.screenshot({ path: path.join(root, `src/shared/icons/icon-${size}.png`), omitBackground: true });
}
await browser.close();
console.log("icons written");

#!/usr/bin/env node
// Connects Muse Code in one project to Tuck: node bridge/install.mjs <project folder>
// Writes the native messaging manifest for Chrome, and adds Tuck's hooks to the project's
// .muse/hooks.json, keeping what is there. Nothing global in Muse Code changes.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOOK_EVENTS } from "./status.mjs";

const HOST_NAME = "com.tuck.bridge";
const here = import.meta.dirname;

// Chrome's id for an unpacked extension with a fixed key: the first 16 bytes of the key's
// SHA-256, in hex, with 0-f written as a-p.
export function extensionId(publicKeyBase64) {
  const hash = crypto.createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex");
  return [...hash.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

// Adds Tuck's hook to each event, once: running this again changes nothing.
export function withTuckHooks(existing, command) {
  const hooks = { ...existing?.hooks };
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event] ?? [];
    const has = groups.some((g) => g.hooks?.some((h) => h.command === command));
    hooks[event] = has ? groups : [...groups, { hooks: [{ type: "command", command }] }];
  }
  return { ...existing, hooks };
}

function chromeHostsDir() {
  if (process.platform !== "darwin") throw new Error("Only macOS is set up for now.");
  return path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts");
}

function install(project) {
  if (!project || !fs.existsSync(project)) throw new Error("Usage: node bridge/install.mjs <project folder>");
  const node = process.execPath; // Chrome and hooks do not get the shell's PATH
  const manifest = JSON.parse(fs.readFileSync(path.join(here, "../src/manifest.json"), "utf8"));

  // Chrome runs a host by its path, with no arguments, so it needs a small launcher.
  const launcher = path.join(here, "host-launcher.sh");
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${node}" "${path.join(here, "host.mjs")}"\n`, { mode: 0o755 });

  const hostsDir = chromeHostsDir();
  fs.mkdirSync(hostsDir, { recursive: true });
  const id = extensionId(manifest.key);
  fs.writeFileSync(
    path.join(hostsDir, `${HOST_NAME}.json`),
    JSON.stringify(
      {
        name: HOST_NAME,
        description: "Tells Tuck whose turn it is in Muse Code",
        path: launcher,
        type: "stdio",
        allowed_origins: [`chrome-extension://${id}/`],
      },
      null,
      2,
    ),
  );

  const hooksFile = path.join(project, ".muse", "hooks.json");
  const existing = fs.existsSync(hooksFile) ? JSON.parse(fs.readFileSync(hooksFile, "utf8")) : {};
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const command = `"${node}" "${path.join(here, "tuck-hook.mjs")}"`;
  fs.writeFileSync(hooksFile, `${JSON.stringify(withTuckHooks(existing, command), null, 2)}\n`);

  console.log(`Chrome host: ${HOST_NAME}, for extension ${id}`);
  console.log(`Muse hooks: ${hooksFile}`);
  console.log("Next: reload Tuck in chrome://extensions, then start muse in that folder and trust it.");
}

if (process.argv[1] === import.meta.filename) {
  try {
    install(process.argv[2]);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

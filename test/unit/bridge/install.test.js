import test from "node:test";
import assert from "node:assert/strict";
import { chromeHostsDirs } from "../../../bridge/install.mjs";

test("macOS: the manifest goes in Chrome's folder", () => {
  assert.deepEqual(chromeHostsDirs("darwin", "/Users/a"), [
    "/Users/a/Library/Application Support/Google/Chrome/NativeMessagingHosts",
  ]);
});

test("Linux: the manifest goes in the folders of both Google Chrome and Chromium", () => {
  assert.deepEqual(chromeHostsDirs("linux", "/home/a"), [
    "/home/a/.config/google-chrome/NativeMessagingHosts",
    "/home/a/.config/chromium/NativeMessagingHosts",
  ]);
});

test("any other platform stops with a message", () => {
  assert.throws(() => chromeHostsDirs("win32", "C:/a"), /Only macOS and Linux/);
});

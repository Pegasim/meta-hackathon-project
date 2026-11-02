// Functions run inside the page in front for the second look, through
// chrome.scripting.executeScript({ func }). Chrome sends each function's source on its
// own, so each must be self-contained: no imports, no names from outside it. They run
// in this extension's isolated world, where a value left on `window` stays for the
// page's life. Covered by the extension e2e.

// Notes when a key was last pressed or a field last changed on this page: a time,
// never which key or what text. Installs once per page.
export function watchTyping() {
  if (window.__tuckTyping) return true;
  window.__tuckTyping = { last: 0 };
  const mark = () => (window.__tuckTyping.last = Date.now());
  addEventListener("keydown", mark, { capture: true, passive: true });
  addEventListener("input", mark, { capture: true, passive: true });
  return true;
}

// Is Tuck on this page? A reload keeps the tab and URL but wipes what was injected.
export const tuckThere = () => !!window.__tuckInstalled;

// Is the person typing on this page: is the focus in a field that takes text, and did
// they type within recentMs? A field left focused while scrolling is not typing. Reads
// no text. Tuck's own bubble does not count.
export function isComposing(recentMs) {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) {
    if (el.id === "tuck-companion") return false;
    el = el.shadowRoot.activeElement;
  }
  if (!el || el === document.body || el.id === "tuck-companion") return false;
  const notText = ["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image", "hidden"];
  const field =
    el.isContentEditable ||
    el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" && !notText.includes((el.type || "text").toLowerCase()));
  return field && Date.now() - (window.__tuckTyping?.last ?? 0) < recentMs;
}

// Notes the conversation the person last touched: a dialog holding a text box, or the
// main area of a messaging section, by the URL's first segment (a comment box on a feed
// or an article about chat is not a conversation). Touching
// anything else ends it, so a chat left open does not speak for the feed, and neither
// does the focus, which stays in the chat's box while the feed scrolls. Keeps the element
// only: no text is read here. composedPath and nodeType, because chats live in shadow
// roots (LinkedIn's does): event.target is the host there. Installs once per page.
export function watchRegion() {
  if (window.__tuckRegion) return true;
  window.__tuckRegion = { el: null };
  const BOX = '[role="textbox"], [contenteditable="true"], [contenteditable=""], textarea';
  const touched = (event) => {
    const path = event.composedPath().filter((n) => n.nodeType === 1);
    if (path.some((el) => el.id === "tuck-companion")) return; // Tuck's own bubble says nothing
    const messaging = /^\/(messaging|messages?|chats?|inbox|direct|dm)(\/|$)/i.test(location.pathname);
    let found = null;
    for (const el of path) {
      if (el === document.body) break;
      const chat = el.getAttribute("role") === "dialog" || (messaging && el.tagName === "MAIN");
      if (chat && el.querySelector(BOX)) {
        found = el;
        break;
      }
    }
    if (found === window.__tuckRegion.el) return;
    window.__tuckRegion.el = found;
    try {
      chrome.runtime.sendMessage({ type: "record-active" }).catch(() => {});
    } catch {} // the extension was reloaded
  };
  for (const type of ["pointerdown", "wheel", "keydown"])
    addEventListener(type, touched, { capture: true, passive: true });
  return true;
}

// Where the person is working: { kind: "conversation", labels: [heading] } or
// { kind: "page", labels: [] }. The heading nearest the text box is the only text read
// (LinkedIn's own labels carry message text). Read fresh, so a closed chat is a page and
// an opened thread has its own name.
export function readRegion() {
  const page = { kind: "page", labels: [] };
  const el = window.__tuckRegion?.el;
  if (!el?.isConnected) return page;
  const box = el.querySelector('[role="textbox"], [contenteditable="true"], [contenteditable=""], textarea');
  if (!box) return page;
  for (let n = box.parentElement; n; n = n === el ? null : n.parentElement) {
    const text = n.querySelector('h1, h2, h3, h4, [role="heading"]')?.innerText?.trim();
    if (text) return { kind: "conversation", labels: [text.replace(/\s+/g, " ").slice(0, 80)] };
  }
  return { kind: "conversation", labels: [] };
}

// A short excerpt of the visible page: the text around the focused field when
// fromFocus (the person is typing there), else around the middle of the window. Never
// reads form values or drafts, and reads nothing when a password field is visible,
// also inside open shadow roots and same-origin frames. Returns { password, text }, or
// null when the tab has moved on from url.
export function readExcerpt(url, maxChars, minChars, fromFocus) {
  if (location.href !== url) return null;
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const hasPassword = (root) => {
    if ([...root.querySelectorAll('input[type="password"]')].some(shown)) return true;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot && hasPassword(el.shadowRoot)) return true;
      if (el.tagName === "IFRAME" && shown(el)) {
        let doc = null;
        try {
          doc = el.contentDocument; // null or a throw for another origin
        } catch {}
        if (doc && hasPassword(doc)) return true;
      }
    }
    return false;
  };
  if (hasPassword(document)) return { password: true, text: "" };
  let focus = document.activeElement;
  while (focus?.shadowRoot?.activeElement && focus.id !== "tuck-companion") focus = focus.shadowRoot.activeElement;
  const typing =
    fromFocus &&
    !!focus &&
    focus !== document.body &&
    focus.id !== "tuck-companion" &&
    (focus.isContentEditable || focus.tagName === "TEXTAREA" || focus.tagName === "INPUT");
  const flat = (s) => (s || "").replace(/\s+/g, " ").trim();
  // Climb from there until the container holds enough text to say what it is about.
  let node = typing ? focus : document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  let text = "";
  for (; node && node !== document.documentElement; node = node.parentElement) {
    text = flat(node.innerText);
    if (text.length >= minChars) break;
  }
  // innerText has no form values; drafts in editable boxes are the person's, not the page's.
  for (const box of node?.querySelectorAll?.('[contenteditable=""], [contenteditable="true"]') ?? []) {
    const draft = flat(box.innerText);
    if (draft) text = flat(text.replace(draft, " "));
  }
  // Next to a text field the newest lines (a chat's last messages) are at the end.
  return { password: false, text: typing ? text.slice(-maxChars) : text.slice(0, maxChars) };
}

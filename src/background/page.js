// Functions run inside the page in front for the second look, through
// chrome.scripting.executeScript({ func }). Chrome sends each function's source on its
// own, so each must be self-contained: no imports, no names from outside it. They run
// in this extension's isolated world, where a value left on `window` stays for the
// page's life. Covered by the extension e2e.

// Notes when a key was last pressed or a field last changed on this page: a time,
// never which key or what text. With keep (a page Tuck may read), also the spot to take
// the person back to (#60): the last field typed in, as an element, its caret (a number)
// and the scroll position, saved per URL in session storage for a reload. Never a
// password field. Installs once per page; keep is set on every call.
export function watchTyping(keep = false) {
  if (window.__tuckTyping) return ((window.__tuckTyping.keep = keep), true);
  window.__tuckTyping = { last: 0, keep, spot: null };
  const state = window.__tuckTyping;
  const mark = (event) => {
    state.last = Date.now();
    if (!state.keep) return;
    const el = event.composedPath().find((n) => n.nodeType === 1);
    if (!el || el.closest?.("#tuck-companion")) return;
    const field =
      el.isContentEditable ||
      el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && /^(text|search|url|email|tel|number)?$/i.test(el.type));
    if (!field) return;
    let caret = null;
    try {
      caret = typeof el.selectionEnd === "number" ? el.selectionEnd : null;
    } catch {} // some inputs (number, email) throw on selection
    state.spot = { el, caret };
  };
  addEventListener("keydown", mark, { capture: true, passive: true });
  addEventListener("input", mark, { capture: true, passive: true });
  let timer = 0;
  addEventListener(
    "scroll",
    () => {
      if (!state.keep) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          sessionStorage.setItem(`tuck-scroll|${location.href}`, String(Math.round(scrollY)));
        } catch {} // storage blocked
      }, 200);
    },
    { capture: true, passive: true },
  );
  return true;
}

// "Take me back" (#60): scroll to the field last typed in, put the focus and caret back,
// and ring it for about 2 s (no ring under reduced motion). After a reload the field is
// gone: the scroll position saved for this URL comes back instead. Reads no text.
// Returns "field", "scroll" or null (nothing kept: the tab in front, as before).
export function returnToSpot(ringMs) {
  const spot = window.__tuckTyping?.spot;
  const el = spot?.el;
  if (el?.isConnected && el.type !== "password") {
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
    if (spot.caret != null)
      try {
        el.setSelectionRange(spot.caret, spot.caret);
      } catch {}
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const r = el.getBoundingClientRect();
      const ring = document.createElement("div");
      ring.id = "tuck-spot";
      ring.style.cssText =
        `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;` +
        "border:2px solid #1b1b1f;outline:2px solid #fff;border-radius:6px;pointer-events:none;z-index:2147483646";
      document.documentElement.append(ring);
      setTimeout(() => ring.remove(), ringMs);
    }
    return "field";
  }
  let y = null;
  try {
    y = sessionStorage.getItem(`tuck-scroll|${location.href}`);
  } catch {}
  if (y == null) return null;
  scrollTo(0, Number(y));
  return "scroll";
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
// fromFocus (the person is typing there), else the conversation last touched (watchRegion),
// else around the middle of the window, into any open shadow root there. Never reads form
// values or drafts, and reads nothing when a password field is visible, also inside open
// shadow roots and same-origin frames. Returns { password, text, from }, from: where it
// read ("conversation", "focus" or "view"), or null when the tab has moved on from url.
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
  // Not typing, but in a conversation: it is what the person is looking at, wherever it sits.
  const region = window.__tuckRegion?.el;
  const chat = !typing && region?.isConnected && shown(region) && flat(region.innerText) ? region : null;
  // The element at the middle of the window. A lookup there stops at an open shadow root's
  // host, so go in, a few levels at most. Tuck's own bubble is not the page.
  const middle = () => {
    let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    for (let i = 0; i < 8 && el?.shadowRoot && el.id !== "tuck-companion"; i++) {
      const inner = el.shadowRoot.elementFromPoint(innerWidth / 2, innerHeight / 2);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  // Climb from there until the container holds enough text to say what it is about. A
  // conversation is read as it is. In a shadow root the climb ends at its first element:
  // innerText does not cross to the host, which holds none of that text.
  let node = typing ? focus : (chat ?? middle());
  let box = node;
  let text = "";
  for (; node && node !== document.documentElement; node = node.parentElement) {
    box = node;
    text = flat(node.innerText);
    if (text.length >= (chat ? 0 : minChars)) break;
  }
  // innerText has no form values; drafts in editable boxes are the person's, not the page's.
  for (const draftBox of box?.querySelectorAll?.('[contenteditable=""], [contenteditable="true"]') ?? []) {
    const draft = flat(draftBox.innerText);
    if (draft) text = flat(text.replace(draft, " "));
  }
  // Next to a text field, or in a conversation, the newest lines are at the end.
  const from =
    chat || (typing && region?.isConnected && region.contains(focus)) ? "conversation" : typing ? "focus" : "view";
  return { password: false, text: typing || chat ? text.slice(-maxChars) : text.slice(0, maxChars), from };
}

// Tuck on the page: draws what background.js decided (see present.js) inside its own
// Shadow DOM. It reads nothing from the page. Top right by default; the person can
// drag it anywhere and it stays there on every page. The bubble opens toward the
// roomier side (layout.js, injected first). Injected with chrome.scripting, possibly
// several times into one page, so it installs once.
(() => {
  if (window.__tuckInstalled) return;
  window.__tuckInstalled = true;

  const { placement, clamp } = globalThis.tuckLayout;
  const HOST_ID = "tuck-companion";
  const OWNER = chrome.runtime.id; // marks our host: another copy of Tuck shares the page's DOM
  const ORPHAN_CHECK_MS = 2000;
  const SIZE = { width: 72, height: 72 };
  const DRAG_THRESHOLD = 4; // px; less is a click
  let root = null;
  let pos = null; // {x, y} of Tuck, in viewport px
  let current = null; // the view on screen
  let timers = [];

  // Removed, disabled or reloaded, the extension leaves this script in the page with no
  // runtime behind it, and its host in the DOM. Nothing tells the page, so look.
  const orphaned = () => !chrome.runtime?.id;
  const orphanCheck = setInterval(() => orphaned() && leavePage(), ORPHAN_CHECK_MS);
  function leavePage() {
    clearInterval(orphanCheck);
    timers.forEach(clearTimeout);
    timers = [];
    window.removeEventListener("resize", place);
    root?.host.remove();
    root = null;
    current = null;
    window.__tuckInstalled = false; // a later load of this extension may install here
  }

  const send = (msg) => (orphaned() ? leavePage() : chrome.runtime.sendMessage(msg).catch(() => {}));
  const view = () => ({ width: window.innerWidth, height: window.innerHeight });

  const STYLE = `
    :host { all: initial; }
    .dock { position: fixed; z-index: 2147483647; width: 72px; height: 72px;
            font: 14px/1.4 system-ui, -apple-system, sans-serif; color: #24262d;
            opacity: 0; transform: scale(.6); transition: opacity .35s ease, transform .45s cubic-bezier(.2,.8,.2,1);
            pointer-events: none; }
    .dock.in { opacity: 1; transform: none; }
    .avatar { all: unset; cursor: grab; pointer-events: auto; border-radius: 16px; touch-action: none; display: block; }
    .avatar.dragging { cursor: grabbing; }
    .avatar:focus-visible { outline: 2px solid #94BFAE; outline-offset: 2px; }
    .tuck { --tuck-accent: #94BFAE; width: 72px; height: 72px; filter: drop-shadow(0 2px 6px rgba(0,0,0,.18)); }
    .bubble { pointer-events: auto; position: absolute; width: 260px; background: #fff; border: 1px solid #dfe3e8;
              border-radius: 14px; padding: 12px 14px; box-shadow: 0 8px 24px rgba(0,0,0,.14); }
    .bubble[hidden] { display: none; }
    .dock[data-side="left"] .bubble { right: 0; }
    .dock[data-side="right"] .bubble { left: 0; }
    .dock[data-vertical="below"] .bubble { top: 80px; }
    .dock[data-vertical="above"] .bubble { bottom: 80px; }
    .text { margin: 0 18px 10px 0; font-weight: 600; }
    .next { margin: -6px 0 10px; color: #65616d; font-size: 13px; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; }
    button.b { all: unset; cursor: pointer; border: 1px solid #cfd5dc; border-radius: 999px; padding: 5px 12px;
               font-size: 13px; color: #24262d; background: #fff; }
    button.b.primary { background: #94BFAE; border-color: #94BFAE; font-weight: 600; color: #1f2a26; }
    button.b:hover { border-color: #94BFAE; }
    button.b:focus-visible { outline: 2px solid #94BFAE; outline-offset: 1px; }
    .close { all: unset; cursor: pointer; position: absolute; top: 6px; right: 10px; color: #8a8f98; font-size: 16px; }
    form { display: grid; gap: 6px; margin: 0; }
    input { all: unset; border: 1px solid #cfd5dc; border-radius: 8px; padding: 6px 8px; font-size: 13px;
            background: #fff; color: #24262d; }
    input:focus { border-color: #94BFAE; }
    .pick { margin-bottom: 8px; display: grid; gap: 6px; }
    @media (prefers-color-scheme: dark) {
      .bubble { background: #24262d; border-color: #3a3d46; color: #eceef1; }
      .dock { color: #eceef1; }
      button.b, input { background: #2d3038; border-color: #464a54; color: #eceef1; }
      button.b.primary { color: #1f2a26; }
      .next { color: #a9adb6; }
    }`;

  function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children.filter(Boolean));
    return e;
  }

  const dock = () => root.querySelector(".dock");
  const art = () => root.querySelector("svg.tuck");
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  // ---- Position ------------------------------------------------------------

  const defaultPos = () => ({ x: window.innerWidth - SIZE.width - 16, y: 16 });

  function place() {
    pos = clamp(pos ?? defaultPos(), SIZE, view());
    const d = dock();
    d.style.left = `${pos.x}px`;
    d.style.top = `${pos.y}px`;
    const { side, vertical } = placement({ ...pos, ...SIZE }, view());
    d.dataset.side = side;
    d.dataset.vertical = vertical;
  }

  async function loadPos() {
    const { tuckPosition } = await chrome.storage.local.get("tuckPosition");
    if (tuckPosition) pos = tuckPosition;
  }

  function makeDraggable(avatar) {
    let start = null;
    let moved = false;
    avatar.addEventListener("pointerdown", (e) => {
      start = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
      moved = false;
      avatar.setPointerCapture(e.pointerId);
    });
    avatar.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.px;
      const dy = e.clientY - start.py;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      avatar.classList.add("dragging");
      pos = { x: start.x + dx, y: start.y + dy };
      place();
    });
    avatar.addEventListener("pointerup", () => {
      if (!start) return;
      start = null;
      avatar.classList.remove("dragging");
      if (moved) chrome.storage.local.set({ tuckPosition: pos });
    });
    // A drag ends with a click event too; only a real click counts.
    avatar.addEventListener("click", (e) => {
      if (moved) return ((moved = false), e.preventDefault());
      if (current?.bubble) closeBubble();
      else send({ type: "tuck-click" });
    });
  }

  // ---- Drawing -------------------------------------------------------------

  // One pet per page. A host left by an earlier load of this extension, or by a version
  // without the owner mark, has nobody drawing it: it goes. A host of another copy that
  // is still installed stays, and this copy does not draw, so two copies never fight;
  // once that copy is gone its host leaves within ORPHAN_CHECK_MS. Returns whether Tuck
  // is ours to draw.
  function ensureRoot({ svg, css }) {
    if (root?.isConnected) return true;
    for (const other of document.querySelectorAll(`#${HOST_ID}`)) {
      if (other.dataset.owner && other.dataset.owner !== OWNER) return false;
      other.remove();
    }
    const host = el("div", { id: HOST_ID });
    host.dataset.owner = OWNER;
    const shadow = host.attachShadow({ mode: "open" });
    const avatar = el("button", { className: "avatar", ariaLabel: "Open Tuck", title: "Tuck — drag to move" });
    avatar.innerHTML = svg;
    const svgEl = avatar.querySelector("svg");
    svgEl.setAttribute("aria-hidden", "true");
    svgEl.removeAttribute("role");
    svgEl.removeAttribute("aria-label");
    const bubble = el("div", { className: "bubble", hidden: true, role: "status", ariaLive: "polite" });
    // Site shortcuts (YouTube's k, Gmail's c) must not fire while typing to Tuck.
    for (const type of ["keydown", "keyup", "keypress"]) bubble.addEventListener(type, (e) => e.stopPropagation());
    shadow.append(el("style", { textContent: css + STYLE }), el("div", { className: "dock" }, avatar, bubble));
    document.documentElement.append(host);
    root = shadow;
    makeDraggable(avatar);
    place();
    window.addEventListener("resize", place);
    return true;
  }

  function setState(state) {
    const svg = art();
    svg.dataset.state = state;
    // Replay the state's entrance even when the state repeats.
    for (const part of svg.querySelectorAll("*"))
      for (const a of part.getAnimations()) if (a.effect?.getTiming().iterations !== Infinity) (a.cancel(), a.play());
  }

  function closeBubble() {
    root.querySelector(".bubble").hidden = true;
    if (current) current = { ...current, bubble: null };
    setState("resting");
  }

  function leave() {
    dock().classList.remove("in");
    current = null;
  }

  function drawBubble(b) {
    const box = root.querySelector(".bubble");
    box.replaceChildren();
    if (!b) return (box.hidden = true);
    box.hidden = false;
    box.append(el("p", { className: "text", textContent: b.text }));
    if (b.reminder) {
      const { id, title, line } = b.reminder;
      const part = el("div", { className: "reminder" });
      const answer = (choice, label) => {
        const button = el("button", {
          className: "b",
          textContent: label,
          onclick: () => {
            part.remove();
            send({ type: "reminder-answer", id, title, choice });
          },
        });
        button.dataset.reminder = choice;
        return button;
      };
      part.append(
        el("p", { className: "text", textContent: line }),
        el("p", { className: "next", textContent: title }),
        el(
          "div",
          { className: "row" },
          answer("on_it", "On it"),
          answer("switch", "Switch to this"),
          answer("done", "Done"),
        ),
      );
      box.append(part);
    }
    if (b.kind === "nudge") {
      const row = el("div", { className: "row" });
      for (const btn of b.buttons) {
        const button = el("button", {
          className: `b${btn.primary ? " primary" : ""}`,
          textContent: btn.label,
          onclick: () => send({ type: "respond", choice: btn.choice }),
        });
        button.dataset.choice = btn.choice;
        row.append(button);
      }
      box.append(row);
    }
    if (b.kind === "card") {
      if (b.next) box.append(el("p", { className: "next", textContent: `Next: ${b.next}` }));
      box.append(
        el(
          "div",
          { className: "row" },
          el("button", {
            className: "b primary",
            textContent: "Done",
            onclick: () => send({ type: "complete-intent", from: "tuck" }),
          }),
          el("button", { className: "b", textContent: "Change", onclick: () => send({ type: "tuck-change" }) }),
        ),
      );
    }
    if (b.kind === "goal") {
      if (b.pickUp?.length) {
        const pick = el("div", { className: "pick" });
        for (const title of b.pickUp)
          pick.append(
            el("button", {
              className: "b",
              textContent: `Pick up: ${title}`,
              onclick: () => send({ type: "set-intent", title, from: "tuck" }),
            }),
          );
        box.append(pick);
      }
      const goal = el("input", { name: "goal", placeholder: "What's the goal?", required: true, maxLength: 120 });
      const step = el("input", { name: "step", placeholder: "First step (optional)", maxLength: 200 });
      const start = el("button", { className: "b primary start", type: "submit", textContent: "Start" });
      const form = el("form", {}, goal, step, el("div", { className: "row" }, start));
      form.onsubmit = (e) => {
        e.preventDefault();
        const title = goal.value.trim();
        if (title.length >= 3) send({ type: "set-intent", title, next: step.value.trim(), from: "tuck" });
      };
      box.append(form);
      setTimeout(() => goal.focus(), 300);
    }
    if (b.dismissable || b.kind === "goal" || b.kind === "card")
      box.append(
        el("button", {
          className: "close",
          ariaLabel: "Close",
          textContent: "×",
          onclick: () => (b.kind === "nudge" ? send({ type: "respond", choice: "dismiss" }) : closeBubble()),
        }),
      );
  }

  async function show(v, assets) {
    if (!root?.isConnected) await loadPos();
    if (!ensureRoot(assets)) return;
    // Quiet presence never interrupts what is on screen.
    if (v.quiet && current) return;
    timers.forEach(clearTimeout);
    timers = [];
    current = v;
    place();
    setState(v.tuck);
    drawBubble(v.bubble);
    if (v.instant) {
      // Back after a reload: already there, not sliding in again.
      dock().style.transition = "none";
      dock().classList.add("in");
      requestAnimationFrame(() => (dock().style.transition = ""));
    } else requestAnimationFrame(() => dock().classList.add("in"));
    if (v.settle) later(1400, () => setState(v.settle));
    if (v.closeBubbleAfterMs) later(v.closeBubbleAfterMs, closeBubble);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "tuck-show") show(msg.view, msg.assets);
    else if (msg?.type === "tuck-hide" && root) leave();
    else if (msg?.type === "tuck-rest" && root && current)
      (drawBubble(null), setState("resting"), (current.bubble = null));
  });
})();

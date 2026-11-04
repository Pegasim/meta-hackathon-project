// Tuck on the page: draws what background.js decided (see present.js) inside its own
// Shadow DOM. It reads nothing from the page. Top right by default; the person can
// drag it anywhere and it stays there on every page, the open ones too. The bubble opens toward the
// roomier side (layout.js, injected first). The art is the chosen skin's (skins.js,
// injected first too, sets its pose attributes). Injected with chrome.scripting, possibly
// several times into one page, so it installs once.
(() => {
  if (window.__tuckInstalled) return;
  window.__tuckInstalled = true;

  const { placement, clamp, anchor, fromAnchor } = globalThis.tuckLayout;
  const { poseAttrs, themeCss } = globalThis.tuckSkins;
  const HOST_ID = "tuck-companion";
  const OWNER = chrome.runtime.id; // marks our host: another copy of Tuck shares the page's DOM
  const ORPHAN_CHECK_MS = 2000;
  let SIZE = { width: 72, height: 72 }; // the skin's (skin.json size)
  const DRAG_THRESHOLD = 4; // px; less is a click
  let root = null;
  let pos = null; // {x, y} of Tuck on screen, in viewport px: saved, fitted to this window
  let saved = null; // where the person put Tuck (layout.js anchor); fitting never changes it
  let dragging = false;
  let current = null; // the view on screen
  let skin = null; // the skin drawn: its manifest
  let item = "none"; // what Tuck wears or carries (skin.json items)
  let pose = "rest";
  let resting = "rest"; // the pose with nothing to say (the last quiet view's): rest, work or sleep
  let timers = [];
  let hides = 0; // tuck-hide messages seen: a show that waited past one is stale
  let enterFrame = null; // the slide-in waiting for the next frame; a hide before it cancels it

  // Removed, disabled or reloaded, the extension leaves this script in the page with no
  // runtime behind it, and its host in the DOM. Nothing tells the page, so look.
  const orphaned = () => !chrome.runtime?.id;
  const orphanCheck = setInterval(() => orphaned() && leavePage(), ORPHAN_CHECK_MS);
  function leavePage() {
    clearInterval(orphanCheck);
    cancelAnimationFrame(enterFrame);
    clearTimeout(spriteTimer);
    timers.forEach(clearTimeout);
    timers = [];
    window.removeEventListener("resize", place);
    try {
      chrome.storage.onChanged.removeListener(follow);
    } catch {} // no runtime left to ask
    root?.host.remove();
    root = null;
    current = null;
    window.__tuckInstalled = false; // a later load of this extension may install here
  }

  const send = (msg) => (orphaned() ? leavePage() : chrome.runtime.sendMessage(msg).catch(() => {}));
  const view = () => ({ width: window.innerWidth, height: window.innerHeight });

  const STYLE = `
    :host { all: initial; }
    .dock { position: fixed; z-index: 2147483647; width: var(--tk-w); height: var(--tk-h);
            font: 13px/1.4 ui-rounded, system-ui, -apple-system, sans-serif; color: var(--tk-ink);
            opacity: 0; transform: scale(.6); transition: opacity .35s ease, transform .45s cubic-bezier(.2,.8,.2,1);
            pointer-events: none; }
    .dock.in { opacity: 1; transform: none; }
    @media (prefers-reduced-motion: reduce) { .dock { transition: none; } }
    .avatar { all: unset; cursor: grab; pointer-events: auto; border-radius: 16px; touch-action: none; display: block; }
    .avatar.dragging { cursor: grabbing; }
    .avatar:focus-visible { outline: 2px solid var(--tk-ink); outline-offset: 2px; }
    .tuck { --tuck-accent: var(--tk-accent); width: var(--tk-w); height: var(--tk-h);
            filter: drop-shadow(0 0 .6px var(--tk-rim)) drop-shadow(0 2px 6px rgba(0,0,0,.18)); }
    .bubble { pointer-events: auto; position: absolute; width: 260px; background: var(--tk-surface); color: var(--tk-ink);
              border: 1px solid var(--tk-outline); border-radius: 16px; padding: 12px 14px; font-weight: 400;
              box-shadow: 0 8px 24px rgba(0,0,0,.14); }
    .bubble::before { content: ""; position: absolute; width: 10px; height: 10px; background: var(--tk-surface);
                      border: 1px solid var(--tk-outline); border-width: 1px 0 0 1px; }
    .bubble[hidden] { display: none; }
    .dock[data-side="left"] .bubble { right: 0; }
    .dock[data-side="right"] .bubble { left: 0; }
    .dock[data-side="left"] .bubble::before { right: calc(var(--tk-w) / 2 - 5px); }
    .dock[data-side="right"] .bubble::before { left: calc(var(--tk-w) / 2 - 5px); }
    .dock[data-vertical="below"] .bubble { top: calc(var(--tk-h) + 8px); }
    .dock[data-vertical="below"] .bubble::before { top: -6px; transform: rotate(45deg); }
    .dock[data-vertical="above"] .bubble { bottom: calc(var(--tk-h) + 8px); }
    .dock[data-vertical="above"] .bubble::before { bottom: -6px; transform: rotate(225deg); }
    .text { margin: 0 18px 10px 0; font-size: 14px; font-weight: 600; }
    .next { margin: -6px 0 10px; color: var(--tk-muted); font-size: 13px; }
    .plan { margin: -4px 0 10px; padding-left: 18px; color: var(--tk-muted); font-size: 13px; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; }
    button.b { all: unset; cursor: pointer; border: 1px solid var(--tk-outline); border-radius: 999px; padding: 5px 12px;
               font-size: 13px; color: var(--tk-ink); background: var(--tk-surface); }
    button.b.primary { background: var(--tk-accent); border-color: var(--tk-accent); font-weight: 600; color: var(--tk-on-accent); }
    button.b:hover { border-color: var(--tk-accent); }
    button.b:focus-visible { outline: 2px solid var(--tk-ink); outline-offset: 1px; }
    .close { all: unset; cursor: pointer; position: absolute; top: 6px; right: 10px; color: var(--tk-muted); font-size: 16px; }
    .close:hover { color: var(--tk-ink); }
    .close:focus-visible { outline: 2px solid var(--tk-ink); outline-offset: 1px; border-radius: 4px; }
    form { display: grid; gap: 6px; margin: 0; }
    input { all: unset; border: 1px solid var(--tk-outline); border-radius: 8px; padding: 6px 8px; font-size: 13px;
            background: var(--tk-surface); color: var(--tk-ink); }
    input:focus { border-color: var(--tk-accent); }
    input:focus-visible { outline: 2px solid var(--tk-ink); outline-offset: 1px; }
    .pick { margin-bottom: 8px; display: grid; gap: 6px; }`;

  function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children.filter(Boolean));
    return e;
  }

  const dock = () => root.querySelector(".dock");
  const art = () => root.querySelector("svg.tuck");

  // ---- Sprite skins ---------------------------------------------------------
  // A sprite skin's pose is a strip of frames (skin.json frames). Entrances play once and
  // hold; only work loops; rest replays its breath now and then; a pose with gaze turns to
  // the bubble once it has played. Reduced motion holds the frame and plays nothing.
  let spriteTimer = null;
  // Settings → Tuck's motion: "system" follows the computer's reduce-motion setting, "on"
  // always animates, "off" keeps every pose still.
  let motion = "system";
  const reducedMotion = () =>
    motion === "off" || (motion !== "on" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const isSprite = () => skin?.kind === "sprites";
  function spriteFrame(strip, i) {
    // Removed or reloaded, the extension leaves this script with no runtime behind it.
    if (orphaned()) return leavePage();
    const img = art()?.querySelector(".tuck__strip");
    const f = skin.frames[strip];
    if (!img || !f) return;
    img.setAttribute("href", chrome.runtime.getURL(`tuck/skins/${skin.id}/frames/${strip}.png`));
    const w = (skin.frame ?? skin.size).width;
    img.setAttribute("width", w * f.count);
    img.setAttribute("x", -w * (i % f.count));
  }
  // The look frame toward the bubble: the look strip runs clockwise from up in 22.5° steps.
  function gazeFrame() {
    const d = dock()?.dataset ?? {};
    const deg = d.side === "left" ? (d.vertical === "above" ? 315 : 225) : d.vertical === "above" ? 45 : 135;
    return deg / 22.5;
  }
  function holdSprite(strip) {
    const f = skin.frames[strip];
    if (f.gaze && current?.bubble && skin.frames.look) spriteFrame("look", gazeFrame());
    // An entrance settles on the resting frame, so the face does not jump between poses.
    else if (f.count > 1 && strip !== "work" && skin.frames.rest) strip = (spriteFrame("rest", 0), "rest");
    else spriteFrame(strip, 0);
    // Settled on rest (its own or after an entrance): the idle breath comes back now and then.
    const every = skin.frames[strip].every;
    if (every && !reducedMotion()) spriteTimer = setTimeout(() => playSprite(strip), every);
  }
  function playSprite(strip) {
    clearTimeout(spriteTimer);
    const f = skin.frames[strip];
    if (!f) return;
    if (reducedMotion() || f.count === 1) return holdSprite(strip);
    const total = f.loop ? Infinity : f.count * (f.repeat ?? 1);
    let i = 0;
    const tick = () => {
      if (i >= total) return holdSprite(strip);
      spriteFrame(strip, i++);
      spriteTimer = setTimeout(tick, 1000 / (f.fps ?? 6));
    };
    tick();
  }
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  // ---- Position ------------------------------------------------------------

  const defaultPos = () => ({ x: window.innerWidth - SIZE.width - 16, y: 16 });

  function place() {
    pos = clamp(saved ? fromAnchor(saved, SIZE, view()) : defaultPos(), SIZE, view());
    const d = dock();
    d.style.left = `${pos.x}px`;
    d.style.top = `${pos.y}px`;
    const { side, vertical } = placement({ ...pos, ...SIZE }, view());
    d.dataset.side = side;
    d.dataset.vertical = vertical;
  }

  async function loadPos() {
    const { tuckPosition } = await chrome.storage.local.get("tuckPosition");
    saved = tuckPosition ?? null;
  }

  // Dragged in another tab: this one follows, also while in the background. Our own
  // drag is already on screen.
  function follow(changes, area) {
    if (area !== "local" || !changes.tuckPosition || dragging) return;
    saved = changes.tuckPosition.newValue ?? null;
    if (root?.isConnected) place();
  }
  chrome.storage.onChanged.addListener(follow);

  function makeDraggable(avatar) {
    let start = null;
    let dragged = false;
    avatar.addEventListener("pointerdown", (e) => {
      start = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
      dragged = false;
      avatar.setPointerCapture(e.pointerId);
    });
    avatar.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.px;
      const dy = e.clientY - start.py;
      if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (isSprite() && !reducedMotion()) {
        const strip = e.clientX >= (start.lastX ?? start.px) ? "drag-right" : "drag-left";
        if (strip !== start.strip && skin.frames[strip]) playSprite((start.strip = strip));
      }
      start.lastX = e.clientX;
      dragged = dragging = true;
      avatar.classList.add("dragging");
      saved = anchor(clamp({ x: start.x + dx, y: start.y + dy }, SIZE, view()), SIZE, view());
      place();
    });
    avatar.addEventListener("pointerup", () => {
      if (!start) return;
      if (start.strip) setPose(pose); // stop running: back to the pose
      start = null;
      dragging = false;
      avatar.classList.remove("dragging");
      if (dragged) chrome.storage.local.set({ tuckPosition: saved });
    });
    // A drag ends with a click event too; only a real click counts.
    avatar.addEventListener("click", (e) => {
      if (dragged) return ((dragged = false), e.preventDefault());
      // A nudge is answered, as × answers it (Tuck tucked away then leaves with it).
      if (current?.bubble?.kind === "nudge") send({ type: "respond", choice: "dismiss" });
      else if (current?.bubble) {
        if (current.bubble.kind === "goal") send({ type: "goal-form-closed" });
        closeBubble();
      } else send({ type: "tuck-click" });
    });
  }

  // ---- Drawing -------------------------------------------------------------

  // One pet per page. A host left by an earlier load of this extension, or by a version
  // without the owner mark, has nobody drawing it: it goes. A host of another copy that
  // is still installed stays, and this copy does not draw, so two copies never fight;
  // once that copy is gone its host leaves within ORPHAN_CHECK_MS. Returns whether Tuck
  // is ours to draw.
  function ensureRoot({ manifest, svg, css, item: worn, motion: moves }) {
    item = manifest.items?.includes(worn) ? worn : "none";
    motion = moves ?? "system";
    if (root?.isConnected) {
      if (manifest.id !== skin.id) drawSkin({ manifest, svg, css }); // a new skin, in place: the bubble stays
      return true;
    }
    for (const other of document.querySelectorAll(`#${HOST_ID}`)) {
      if (other.dataset.owner && other.dataset.owner !== OWNER) return false;
      other.remove();
    }
    const host = el("div", { id: HOST_ID });
    host.dataset.owner = OWNER;
    const shadow = host.attachShadow({ mode: "open" });
    const avatar = el("button", { className: "avatar", ariaLabel: "Open Tuck", title: "Tuck — drag to move" });
    const bubble = el("div", { className: "bubble", hidden: true, role: "status", ariaLive: "polite" });
    // Site shortcuts (YouTube's k, Gmail's c) must not fire while typing to Tuck.
    for (const type of ["keydown", "keyup", "keypress"]) bubble.addEventListener(type, (e) => e.stopPropagation());
    shadow.append(el("style"), el("div", { className: "dock" }, avatar, bubble));
    document.documentElement.append(host);
    root = shadow;
    drawSkin({ manifest, svg, css });
    makeDraggable(avatar);
    window.addEventListener("resize", place);
    return true;
  }

  // The skin's art, its theme and size; the pose on screen carries over.
  function drawSkin({ manifest, svg, css }) {
    clearTimeout(spriteTimer); // a frame of the old skin must not land on the new one
    skin = manifest;
    SIZE = manifest.size;
    root.querySelector("style").textContent = css + themeCss(manifest.theme) + STYLE;
    const avatar = root.querySelector(".avatar");
    avatar.innerHTML = svg;
    const svgEl = avatar.querySelector("svg");
    svgEl.setAttribute("aria-hidden", "true");
    svgEl.removeAttribute("role");
    svgEl.removeAttribute("aria-label");
    dock().style.setProperty("--tk-w", `${SIZE.width}px`);
    dock().style.setProperty("--tk-h", `${SIZE.height}px`);
    setPose(pose);
    place();
  }

  function setPose(next) {
    pose = next;
    clearTimeout(spriteTimer);
    const svg = art();
    // "Keep Tuck still" for SVG skins too (their CSS stops on data-motion="off").
    if (motion === "off") svg.dataset.motion = "off";
    else delete svg.dataset.motion;
    for (const [name, value] of Object.entries(poseAttrs(skin, next))) svg.setAttribute(name, value);
    svg.dataset.item = item;
    if (isSprite()) return playSprite(svg.dataset.pose);
    // Replay the pose's entrance even when the pose repeats.
    for (const part of svg.querySelectorAll("*"))
      for (const a of part.getAnimations()) if (a.effect?.getTiming().iterations !== Infinity) (a.cancel(), a.play());
  }

  function closeBubble() {
    root.querySelector(".bubble").hidden = true;
    if (current) current = { ...current, bubble: null };
    setPose(resting);
  }

  function leave() {
    cancelAnimationFrame(enterFrame); // a show still waiting for its frame must not bring Tuck back
    clearTimeout(spriteTimer); // a hidden Tuck plays nothing
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
      // The plan from the person's notes (#78), the next step left out since it is above.
      const rest = (b.plan ?? []).filter((step) => step !== b.next);
      if (rest.length)
        box.append(el("ol", { className: "plan" }, ...rest.map((step) => el("li", { textContent: step }))));
      if (b.watchOut) box.append(el("p", { className: "next watch", textContent: `Watch out: ${b.watchOut}` }));
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
          el("button", { className: "b", textContent: "Tuck away", onclick: () => send({ type: "tuck-away" }) }),
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
          onclick: () => {
            if (b.kind === "nudge") return send({ type: "respond", choice: "dismiss" });
            // Closing the goal form without a goal: Tuck stops offering it on new pages for a while.
            if (b.kind === "goal") send({ type: "goal-form-closed" });
            closeBubble();
          },
        }),
      );
  }

  async function show(v, assets) {
    const seen = hides;
    if (!root?.isConnected) await loadPos();
    if (seen !== hides || !ensureRoot(assets)) return;
    // Quiet presence never interrupts a word on screen; after a hop it is what Tuck settles to.
    if (v.quiet) resting = v.pose;
    if (v.quiet && current?.settle) return void (current.settle = v.pose);
    if (v.quiet && current?.bubble) return;
    timers.forEach(clearTimeout);
    timers = [];
    current = v;
    if (v.settle) resting = v.settle; // what Tuck rests as once the word closes
    place();
    setPose(v.pose);
    drawBubble(v.bubble);
    if (v.instant) {
      // Back after a reload: already there, not sliding in again.
      dock().style.transition = "none";
      dock().classList.add("in");
      requestAnimationFrame(() => (dock().style.transition = ""));
    } else {
      cancelAnimationFrame(enterFrame);
      enterFrame = requestAnimationFrame(() => {
        enterFrame = null;
        dock().classList.add("in");
      });
    }
    if (v.settle)
      later(1400, () => {
        if (!current?.settle) return; // gone meanwhile
        setPose(current.settle);
        current.settle = null;
      });
    if (v.closeBubbleAfterMs) later(v.closeBubbleAfterMs, closeBubble);
    if (v.leaveAfterMs) later(v.leaveAfterMs, leave);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "tuck-show") show(msg.view, msg.assets);
    else if (msg?.type === "tuck-look" && root?.isConnected) (ensureRoot(msg.assets), setPose(pose));
    else if (msg?.type === "tuck-hide") (hides++, root && leave());
    else if (msg?.type === "tuck-rest" && root && current)
      (drawBubble(null), setPose(resting), (current.bubble = null));
  });
})();

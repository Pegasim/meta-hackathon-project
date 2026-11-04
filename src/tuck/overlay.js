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
  let lookAt = 0; // when the newest look change this page was sent was read (background assets)
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
    .pick { margin-bottom: 8px; display: grid; gap: 6px; }
    /* The icon row and the goal card above it (menu), and the chat (dock-chat design). */
    .bubble.menu { background: none; border: 0; box-shadow: none; padding: 0; width: auto; }
    .bubble.menu::before { display: none; }
    .menu-wrap { display: grid; gap: 8px; justify-items: end; }
    .dock[data-side="right"] .menu-wrap { justify-items: start; }
    .goalcard { width: 250px; background: var(--tk-surface); border: 1px solid var(--tk-outline); border-radius: 14px;
                padding: 10px 12px; box-shadow: 0 6px 20px rgba(0,0,0,.10); }
    .goalcard .g-title { color: var(--tk-muted); font-size: 12px; }
    .goalcard .g-lab { margin-top: 6px; font-size: 10.5px; font-weight: 600; letter-spacing: .02em; color: var(--tk-muted); }
    .goalcard .g-now { display: flex; gap: 8px; align-items: flex-start; margin-top: 2px; }
    .goalcard .g-step { flex: 1; font-size: 14px; font-weight: 600; line-height: 1.3; }
    .goalcard .g-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px;
                        font-size: 11.5px; color: var(--tk-muted); }
    .dots { display: flex; gap: 4px; align-items: center; }
    .dots i { width: 7px; height: 7px; border-radius: 50%; background: var(--tk-outline); }
    .dots i.done { background: var(--tk-pink); } .dots i.on { background: var(--tk-accent); }
    .dots span { margin-left: 4px; }
    .focus { display: flex; gap: 4px; align-items: center; }
    .focus svg { width: 14px; height: 14px; }
    button.ck { all: unset; cursor: pointer; flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid;
                place-items: center; border: 1.5px solid var(--tk-accent); color: var(--tk-on-accent); position: relative; }
    button.ck svg { width: 14px; height: 14px; opacity: .35; }
    button.ck:hover, button.ck:focus-visible { background: var(--tk-accent); }
    button.ck:hover svg, button.ck:focus-visible svg { opacity: 1; }
    .icons { display: flex; align-items: center; gap: 4px; background: var(--tk-surface); border: 1px solid var(--tk-outline);
             border-radius: 999px; padding: 5px; box-shadow: 0 6px 20px rgba(0,0,0,.10); }
    .icons .sep { width: 1px; height: 26px; background: var(--tk-outline); margin: 0 3px; }
    button.ib { all: unset; cursor: pointer; position: relative; width: 42px; height: 42px; border-radius: 50%;
                display: grid; place-items: center; color: var(--tk-ink); }
    button.ib svg { width: 22px; height: 22px; }
    button.ib:hover { background: color-mix(in srgb, var(--tk-accent) 22%, transparent); }
    button.ib.main { width: 48px; height: 48px; border: 1.5px solid var(--tk-accent); box-sizing: border-box; }
    button.ib:focus-visible, button.ck:focus-visible { outline: 2px solid var(--tk-ink); outline-offset: 1px; }
    .tip { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); white-space: nowrap;
           font-size: 11px; font-weight: 500; background: var(--tk-ink); color: var(--tk-surface); padding: 2px 7px;
           border-radius: 6px; opacity: 0; pointer-events: none; transition: opacity .12s; }
    button:hover > .tip, button:focus-visible > .tip { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { .tip { transition: none; } }
    .bubble.chat { width: 300px; padding: 10px 12px; }
    .c-head { display: flex; align-items: center; gap: 8px; margin: 0 18px 8px 0; font-size: 12px; font-weight: 600;
              color: var(--tk-muted); }
    .c-head .c-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .c-head .c-change { all: unset; cursor: pointer; font-weight: 400; text-decoration: underline; }
    .c-msgs { display: flex; flex-direction: column; gap: 7px; max-height: 300px; overflow-y: auto; }
    .c-msg { max-width: 250px; font-size: 13px; line-height: 1.4; }
    .c-msg .text { margin: 0; font-size: 13px; font-weight: 400; }
    .c-msg.tuck { align-self: flex-start; }
    .c-msg.tuck > .text { background: #fff; border: 1px solid var(--tk-outline); border-radius: 11px 11px 11px 3px; padding: 6px 9px; }
    @media (prefers-color-scheme: dark) { .c-msg.tuck > .text { background: transparent; } }
    .c-msg.me { align-self: flex-end; background: var(--tk-accent); color: var(--tk-on-accent);
                border-radius: 11px 11px 3px 11px; padding: 6px 9px; }
    .c-msg.pending > .text { color: var(--tk-muted); }
    .c-trail { font-size: 11.5px; color: var(--tk-muted); border-left: 2px solid var(--tk-pink); padding: 1px 0 1px 8px;
               margin: 0 0 5px; display: grid; gap: 1px; }
    .c-msg .row, .c-msg .pick { margin-top: 6px; }
    .c-msg .next { margin: 4px 0 0; white-space: pre-line; }
    .c-form { display: flex; gap: 6px; margin-top: 8px; }
    .c-form input { flex: 1; }`;

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
      else if (current?.bubble?.kind === "chat") closeChat();
      else if (current?.bubble) {
        if (current.bubble.kind === "goal") send({ type: "goal-form-closed" });
        closeStuck();
        closeBubble();
        if (current?.away) leave(); // tucked away, Tuck came for this word alone
      } else send({ type: "tuck-click" });
    });
  }

  // ---- Drawing -------------------------------------------------------------

  // One pet per page. A host left by an earlier load of this extension, or by a version
  // without the owner mark, has nobody drawing it: it goes. A host of another copy that
  // is still installed stays, and this copy does not draw, so two copies never fight;
  // once that copy is gone its host leaves within ORPHAN_CHECK_MS. Returns whether Tuck
  // is ours to draw.
  function ensureRoot({ manifest, svg, css, item: worn, motion: moves, readAt }) {
    // Assets read before the newest look change (a word on its way while the person picked
    // another look) keep the look on screen.
    const stale = root?.isConnected && readAt != null && readAt < lookAt;
    if (!stale) {
      item = manifest.items?.includes(worn) ? worn : "none";
      motion = moves ?? "system";
    }
    if (root?.isConnected) {
      if (!stale && manifest.id !== skin.id) drawSkin({ manifest, svg, css }); // a new skin, in place: the bubble stays
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
    // Esc closes the bubble as × does (#59).
    bubble.addEventListener("keydown", (e) => e.key === "Escape" && bubble.querySelector(".close")?.click());
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

  // Closing an "I'm stuck" wait or step ends that ask: a late step is not drawn (#61).
  function closeStuck() {
    if (current?.stuck) send({ type: "stuck-closed", ask: current.stuck });
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

  // ---- The icon row and the chat --------------------------------------------
  const ICON = globalThis.tuckIcons ?? {};
  const svgOf = (name) => {
    const span = el("span");
    span.innerHTML = ICON[name] ?? "";
    return span.firstElementChild ?? span;
  };
  const ACTIONS = {
    chat: { label: "Talk to Tuck", icon: "chat", msg: { type: "chat-open" } },
    stuck: { label: "I'm stuck", icon: "stuck", msg: { type: "chat-say", text: "I'm stuck", stuck: true } },
    break: { label: "5-min break", icon: "brk", msg: { type: "respond", choice: "break" } },
    done: { label: "Done", icon: "done", msg: { type: "complete-intent", from: "tuck" } },
    away: { label: "Tuck away", icon: "away", msg: { type: "tuck-away" } },
  };
  function iconButton(cls, label, icon, onclick) {
    const b = el(
      "button",
      { className: cls, ariaLabel: label, onclick },
      svgOf(icon),
      el("span", { className: "tip", textContent: label }),
    );
    b.type = "button";
    return b;
  }

  function drawMenu(box, b) {
    const wrap = el("div", { className: "menu-wrap" });
    const g = b.goal;
    if (g) {
      const card = el("div", { className: "goalcard" }, el("div", { className: "g-title", textContent: g.title }));
      if (g.now) {
        const now = el("div", { className: "g-now" }, el("div", { className: "g-step", textContent: g.now }));
        if (g.canStep) now.append(iconButton("ck", "Step done", "check", () => send({ type: "step-done" })));
        card.append(el("div", { className: "g-lab", textContent: "NOW" }), now);
      }
      const foot = el("div", { className: "g-foot" });
      if (g.dots) {
        const dots = el("div", { className: "dots" });
        for (let i = 0; i < g.dots.total; i++)
          dots.append(el("i", { className: i < g.dots.done ? "done" : i === g.dots.done ? "on" : "" }));
        dots.append(el("span", { textContent: `${g.dots.done + 1} of ${g.dots.total}` }));
        foot.append(dots);
      } else foot.append(el("span"));
      foot.append(
        el("span", { className: "focus" }, svgOf("timer"), el("span", { textContent: `Focus ${g.focusMin}m` })),
      );
      card.append(foot);
      wrap.append(card);
    }
    const row = el("div", { className: "icons", role: "toolbar", ariaLabel: "Tuck" });
    for (const name of b.actions) {
      const a = ACTIONS[name];
      if (!a) continue;
      row.append(iconButton(name === "chat" ? "ib main" : "ib", a.label, a.icon, () => send(a.msg)));
      if (name === "chat") row.append(el("span", { className: "sep" }));
    }
    wrap.append(row);
    box.append(wrap);
  }

  function drawChat(box, b) {
    const close = el("button", {
      className: "close",
      ariaLabel: "Close",
      textContent: "×",
      onclick: () => closeChat(),
    });
    const head = el("div", { className: "c-head" }, el("span", { className: "c-title", textContent: b.title }));
    if (b.change)
      head.append(
        el("button", { className: "c-change", textContent: "Change", onclick: () => send({ type: "tuck-change" }) }),
      );
    const list = el("div", { className: "c-msgs" });
    for (const m of b.messages) {
      const msg = el("div", { className: `c-msg ${m.from}${m.pending ? " pending" : ""}` });
      if (m.trail?.length)
        msg.append(el("div", { className: "c-trail" }, ...m.trail.map((t) => el("span", { textContent: t }))));
      msg.append(el("p", { className: "text", textContent: m.text }));
      if (m.next) msg.append(el("p", { className: "next", textContent: m.next }));
      if (m.chips?.length) {
        const pick = el("div", { className: "pick" });
        for (const chip of m.chips)
          pick.append(
            el("button", {
              className: "b",
              textContent: chip.label ?? chip,
              onclick: () => send(chip.msg ?? { type: "chat-chip", title: chip }),
            }),
          );
        msg.append(pick);
      }
      if (m.buttons?.length) {
        const row = el("div", { className: "row" });
        for (const btn of m.buttons) {
          const button = el("button", {
            className: `b${btn.primary ? " primary" : ""}`,
            textContent: btn.label,
            onclick: () => send(btn.msg),
          });
          button.dataset.choice = btn.choice ?? "";
          row.append(button);
        }
        msg.append(row);
      }
      list.append(msg);
    }
    const input = el("input", {
      name: b.field.name,
      placeholder: b.field.placeholder,
      maxLength: 200,
      autocomplete: "off",
    });
    const sendBtn = el("button", { className: "b primary start", type: "submit", textContent: "Send" });
    const form = el("form", { className: "c-form" }, input, sendBtn);
    form.onsubmit = (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (text.length < 2) return;
      input.value = "";
      send({ type: "chat-say", text });
    };
    box.append(head, list, form, close);
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
    return input;
  }

  // Closing the chat ends its thread; with no goal it also snoozes the chat on new pages.
  function closeChat() {
    if (current?.bubble?.field?.name === "goal") send({ type: "goal-form-closed" });
    send({ type: "chat-closed" });
    closeBubble();
    if (current?.away) leave();
  }

  function drawBubble(b) {
    const box = root.querySelector(".bubble");
    box.replaceChildren();
    box.className = "bubble";
    if (!b) return (box.hidden = true);
    box.hidden = false;
    if (b.kind === "menu" || b.kind === "chat") {
      box.classList.add(b.kind);
      if (b.kind === "menu") return drawMenu(box, b);
      const input = drawChat(box, b);
      setTimeout(() => input.isConnected && input.focus(), 50);
      return;
    }
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
        el("p", { className: "text", textContent: title }),
        el("p", { className: "next", textContent: line }),
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
    // A stuck step (#61): its minutes under it.
    if (b.kind === "step" && b.next) box.append(el("p", { className: "next", textContent: b.next }));
    if (b.buttons) {
      const row = el("div", { className: "row" });
      for (const btn of b.buttons) {
        const button = el("button", {
          className: `b${btn.primary ? " primary" : ""}`,
          textContent: btn.label,
          // A nudge's answer, or the message the button names ("I'm stuck", "Start this").
          onclick: () => send(btn.msg ?? { type: "respond", choice: btn.choice }),
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
    if (b.kind === "park") {
      // The shortcut with a goal running (#59): a thought noted for later, not opened now.
      const thought = el("input", { name: "thought", placeholder: "What came up?", required: true, maxLength: 120 });
      const form = el(
        "form",
        {},
        thought,
        el(
          "div",
          { className: "row" },
          el("button", { className: "b primary park", type: "submit", textContent: "Park" }),
          el("button", {
            className: "b change",
            type: "button",
            textContent: "Change goal",
            onclick: () => send({ type: "tuck-change" }),
          }),
        ),
      );
      form.onsubmit = (e) => {
        e.preventDefault();
        const text = thought.value.trim();
        if (text.length >= 3) send({ type: "park", text });
      };
      box.append(form);
      setTimeout(() => thought.focus(), 300);
    }
    if (b.dismissable || b.kind === "goal" || b.kind === "card" || b.kind === "park")
      box.append(
        el("button", {
          className: "close",
          ariaLabel: "Close",
          textContent: "×",
          onclick: () => {
            if (b.kind === "nudge") return send({ type: "respond", choice: "dismiss" });
            // Closing the goal form without a goal: Tuck stops offering it on new pages for a while.
            if (b.kind === "goal") send({ type: "goal-form-closed" });
            closeStuck();
            closeBubble();
            if (current?.away) leave(); // tucked away, Tuck came for this word alone
          },
        }),
      );
  }

  async function show(v, assets) {
    const seen = hides;
    if (!root?.isConnected) await loadPos();
    if (seen !== hides || !ensureRoot(assets)) return;
    // The same chat, changed (a message, a lookup line): redrawn in place, draft and focus kept.
    if (v.update && current?.bubble?.kind === "chat" && v.bubble?.kind === "chat" && dock().classList.contains("in")) {
      const old = root.querySelector(".bubble input");
      const draft = old?.value ?? "";
      const focused = old && root.activeElement === old;
      current = v;
      if (v.pose !== pose) setPose(v.pose);
      drawBubble(v.bubble);
      const input = root.querySelector(".bubble input");
      if (input) ((input.value = draft), focused && input.focus());
      return;
    }
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
    // Meant for one stuck ask's wait (#61): anything else on screen stays.
    if (msg?.stuck && current?.stuck !== msg.stuck) return;
    if (msg?.type === "tuck-show") show(msg.view, msg.assets);
    else if (msg?.type === "tuck-look" && root?.isConnected) {
      lookAt = Math.max(lookAt, msg.assets.readAt ?? 0);
      ensureRoot(msg.assets);
      setPose(pose);
    } else if (msg?.type === "tuck-hide") (hides++, root && leave());
    else if (msg?.type === "tuck-rest" && root && current)
      (drawBubble(null), setPose(resting), (current.bubble = null));
  });
})();

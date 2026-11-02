// Where Tuck's bubble opens, and keeping a dragged Tuck inside the window. A classic
// script (injected before overlay.js) that defines globalThis.tuckLayout; pure, so it
// is tested in node.
globalThis.tuckLayout = {
  // rect: Tuck's box; view: {width, height}. The bubble opens toward the roomier side.
  placement(rect, view) {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return { side: cx < view.width / 2 ? "right" : "left", vertical: cy > view.height / 2 ? "above" : "below" };
  },
  clamp({ x, y }, size, view, margin = 8) {
    return {
      x: Math.min(Math.max(x, margin), view.width - size.width - margin),
      y: Math.min(Math.max(y, margin), view.height - size.height - margin),
    };
  },
  // What is saved for a position: its distance from the nearest corner, so Tuck keeps
  // its place in a window of another size. {h, v, dx, dy}: h "left" | "right", v "top" |
  // "bottom", dx and dy the gaps to those edges.
  anchor({ x, y }, size, view) {
    const right = view.width - size.width - x;
    const bottom = view.height - size.height - y;
    return {
      h: x <= right ? "left" : "right",
      v: y <= bottom ? "top" : "bottom",
      dx: Math.round(Math.min(x, right)),
      dy: Math.round(Math.min(y, bottom)),
    };
  },
  // The position a saved anchor stands for in this window, before clamping. A position
  // saved before anchors, {x, y}, is from the top left.
  fromAnchor(saved, size, view) {
    if (!saved.h) return { x: saved.x, y: saved.y };
    return {
      x: saved.h === "left" ? saved.dx : view.width - size.width - saved.dx,
      y: saved.v === "top" ? saved.dy : view.height - size.height - saved.dy,
    };
  },
};

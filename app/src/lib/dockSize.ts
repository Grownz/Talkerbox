// Window size needed to show the docked avatar with the full sidebar. Pure module, tested with `node --test`.

/**
 * Inner width (CSS px) from which the sidebar has its full width and labels: `.rail` is `clamp(184px, 18vw, 232px)`
 * and becomes the 64 px icon rail below 1024 px, so 232 px needs 18vw >= 232, i.e. 1289 px.
 */
export const DOCK_MIN_WIDTH = Math.ceil(232 / 0.18)
/** `.dock` may take at most this share of the window height (`max-height: 45vh`). */
export const DOCK_MAX_VH = 0.45

/**
 * Inner height (CSS px) at which the sidebar shows everything without scrolling and the docked avatar at its full
 * 3:4 size: the other sidebar children and their gaps plus the avatar, and enough height for the 45vh cap.
 */
export function dockNeedHeight(otherHeights: number[], gap: number, padding: number, dockWidth: number): number {
  const dock = (dockWidth * 4) / 3
  const content = otherHeights.reduce((a, b) => a + b, 0) + dock + gap * otherHeights.length + padding
  return Math.ceil(Math.max(content, dock / DOCK_MAX_VH))
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * New outer window bounds so the inner size is at least `need`, all in physical pixels. `win` is the outer window,
 * `frame` the outer minus the inner size (title bar and borders), `area` the monitor work area. Grows only, never
 * shrinks; the window is moved back inside the work area when it would stick out, and a need larger than the work
 * area is cut to it. Returns null when nothing changes.
 */
export function growWindow(win: Rect, frame: { w: number; h: number }, area: Rect, need: { w: number; h: number }): Rect | null {
  const grow = (outer: number, f: number, n: number, room: number) => Math.max(outer, Math.min(n + f, room))
  const w = grow(win.w, frame.w, need.w, area.w)
  const h = grow(win.h, frame.h, need.h, area.h)
  if (w === win.w && h === win.h) return null
  const place = (pos: number, size: number, start: number, room: number) =>
    Math.max(start, Math.min(pos, start + room - size))
  // A window already wider than the area stays where it is (it is only ever grown, never shrunk to fit).
  const x = w > area.w ? win.x : place(win.x, w, area.x, area.w)
  const y = h > area.h ? win.y : place(win.y, h, area.y, area.h)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

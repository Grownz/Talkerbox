// Zoomable image view shared by the mask and part editors: fit/zoom maths, point and edge hit tests, checkerboard.
import { distToSegment } from './maskGeometry.ts'
import type { Point } from './rig'

/** Screen px per image px (`z`) and the image origin on screen. */
export type View = { z: number; ox: number; oy: number }

export const fitZoom = (cw: number, ch: number, w: number, h: number) => Math.min(cw / w, ch / h) * 0.94 || 1

/** The whole image centred in a cw*ch canvas. */
export function fitView(cw: number, ch: number, w: number, h: number): View {
  const z = fitZoom(cw, ch, w, h)
  return { z, ox: (cw - w * z) / 2, oy: (ch - h * z) / 2 }
}

/** Zoom by `f` around screen point (sx, sy), kept between a quarter of the fit zoom and 4x fit (at least 32). */
export function zoomView(v: View, f: number, sx: number, sy: number, fz: number): View {
  const z = Math.min(Math.max(32, fz * 4), Math.max(fz / 4, v.z * f))
  const k = z / v.z
  return { z, ox: sx - (sx - v.ox) * k, oy: sy - (sy - v.oy) * k }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * Zoom and pan of an editor canvas (cw*ch CSS px) showing a W*H image: `size` reads the image size, `redraw` is
 * called after every change. Stays fitted to the canvas until the user zooms or pans.
 */
export class ImageView {
  view: View = { z: 1, ox: 0, oy: 0 }
  fitted = true
  cw = 0
  ch = 0
  private size: () => [number, number]
  private redraw: () => void

  constructor(size: () => [number, number], redraw: () => void) {
    this.size = size
    this.redraw = redraw
  }

  toScreen = ([x, y]: Point): Point => {
    const [W, H] = this.size()
    return [x * W * this.view.z + this.view.ox, y * H * this.view.z + this.view.oy]
  }
  toNorm = (sx: number, sy: number): Point => {
    const [W, H] = this.size()
    return [clamp01((sx - this.view.ox) / this.view.z / W), clamp01((sy - this.view.oy) / this.view.z / H)]
  }
  fit() {
    this.view = fitView(this.cw, this.ch, ...this.size())
    this.fitted = true
    this.redraw()
  }
  zoomAt(f: number, sx = this.cw / 2, sy = this.ch / 2) {
    this.view = zoomView(this.view, f, sx, sy, fitZoom(this.cw, this.ch, ...this.size()))
    this.fitted = false
    this.redraw()
  }
  panBy(dx: number, dy: number) {
    this.view = { ...this.view, ox: this.view.ox + dx, oy: this.view.oy + dy }
    this.fitted = false
    this.redraw()
  }
  /** Sizes the canvas backing store to `wrap` (device px) and refits or redraws. */
  resize(wrap: HTMLElement, canvas: HTMLCanvasElement) {
    const r = wrap.getBoundingClientRect()
    this.cw = r.width
    this.ch = r.height
    const dpr = devicePixelRatio || 1
    canvas.width = Math.round(this.cw * dpr)
    canvas.height = Math.round(this.ch * dpr)
    if (this.fitted) this.fit()
    else this.redraw()
  }
}

/** Index of the point within `r` screen px of (sx, sy) (nearest wins), or -1. */
export function hitPoint(pts: Point[], toScreen: (p: Point) => Point, sx: number, sy: number, r = 8): number {
  let best = -1
  let bd = r
  pts.forEach((p, i) => {
    const [x, y] = toScreen(p)
    const d = Math.hypot(x - sx, y - sy)
    if (d <= bd) [bd, best] = [d, i]
  })
  return best
}

/** Index of the first edge (i -> i+1) within `r` screen px of (sx, sy), or -1. */
export function hitEdge(pts: Point[], closed: boolean, toScreen: (p: Point) => Point, sx: number, sy: number, r = 6): number {
  const n = pts.length
  for (let i = 0; i < (closed ? n : n - 1); i++) if (distToSegment([sx, sy], toScreen(pts[i]), toScreen(pts[(i + 1) % n])) <= r) return i
  return -1
}

// One pattern per canvas and colour pair, so a redraw does not build a new one every frame.
const patterns = new WeakMap<CanvasRenderingContext2D, { key: string; pattern: CanvasPattern }>()

export function checker(ctx: CanvasRenderingContext2D, a: string, b: string): CanvasPattern {
  const key = `${a}|${b}`
  const hit = patterns.get(ctx)
  if (hit?.key === key) return hit.pattern
  const t = document.createElement('canvas')
  t.width = t.height = 16
  const c = t.getContext('2d')!
  c.fillStyle = a
  c.fillRect(0, 0, 16, 16)
  c.fillStyle = b
  c.fillRect(0, 0, 8, 8)
  c.fillRect(8, 8, 8, 8)
  const pattern = ctx.createPattern(t, 'repeat')!
  patterns.set(ctx, { key, pattern })
  return pattern
}

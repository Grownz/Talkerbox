// Zoomable image view shared by the mask and part editors: fit/zoom maths, point and edge hit tests, checkerboard.
import { distToSegment } from './maskGeometry'
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

export function checker(ctx: CanvasRenderingContext2D, a: string, b: string): CanvasPattern {
  const t = document.createElement('canvas')
  t.width = t.height = 16
  const c = t.getContext('2d')!
  c.fillStyle = a
  c.fillRect(0, 0, 16, 16)
  c.fillStyle = b
  c.fillRect(0, 0, 8, 8)
  c.fillRect(8, 8, 8, 8)
  return ctx.createPattern(t, 'repeat')!
}

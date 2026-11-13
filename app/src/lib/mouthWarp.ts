// Lip-driven mouth with face warp (Phase 6): pure geometry, all in image pixels. rigRender.ts draws it on a canvas by
// mapping each mesh triangle with an affine transform (no WebGL). Tested in tests/mouthWarp.test.ts.
//
// The mouth has its own frame: `u` runs from the left to the right mouth corner, `v` points down across it. The seam
// is the line where the lips meet. Opening moves the upper lip up and the lower lip down (most in the middle, nothing
// at the corners); a wide shape pulls the corners out, a round one pulls them in and pushes the lips apart a little.
// Around the lips the displacement falls off smoothly to zero at `radius`, so cheeks and chin follow gently. The face
// mesh has rows that follow the seam, so the only triangles torn apart lie inside the opening, which is filled with
// the mouth colour and covered by the lips; its outer rows and columns never move, so it fits the base image exactly.
import type { Point } from './rig.ts'

export type Tri = [number, number, number]
export interface Mesh {
  src: Point[]
  dst: Point[]
  tris: Tri[]
}

export interface MouthGeo {
  /** Mouth centre (between the corners), frame axes, half the corner distance (px). */
  c: Point
  u: Point
  v: Point
  half: number
  /** Seam offset along `v` at evenly spaced `u` positions from the left to the right corner (0 at both). */
  seam: number[]
  /** Extent of both lips in the frame: |u| <= bx, top..bottom along v. */
  bx: number
  top: number
  bottom: number
  /** Lip thickness above and below the seam (at the middle), and the half height of the torn row. */
  upTh: number
  lowTh: number
  band: number
  /** Falloff distance of the face warp (px); 0 = lips move alone. Mesh reach beyond the lips: radius + pad. */
  radius: number
  pad: number
  upper: Point[]
  lower: Point[]
}

export interface Motion {
  up: number
  low: number
  corner: number
  pucker: number
}

const SEAM_SAMPLES = 21
export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const bboxOf = (pts: Point[]) => ({
  x0: Math.min(...pts.map((p) => p[0])),
  x1: Math.max(...pts.map((p) => p[0])),
  y0: Math.min(...pts.map((p) => p[1])),
  y1: Math.max(...pts.map((p) => p[1])),
})

/**
 * Suggested lips for a mouth outline: corners at its leftmost and rightmost points, the upper lip is the outline
 * above the corner line, the lower lip the part below (each closed along the corner line). Null for a degenerate one.
 */
export function autoSplit(poly: Point[]): { upper: Point[]; lower: Point[]; corners: [Point, Point] } | null {
  if (poly.length < 3) return null
  let li = 0
  let ri = 0
  poly.forEach((p, i) => {
    if (p[0] < poly[li][0]) li = i
    if (p[0] > poly[ri][0]) ri = i
  })
  if (li === ri || poly[ri][0] - poly[li][0] <= 0) return null
  const walk = (from: number, to: number) => {
    const out: Point[] = []
    for (let i = from; ; i = (i + 1) % poly.length) {
      out.push(poly[i])
      if (i === to) return out
    }
  }
  const a = walk(li, ri)
  const b = walk(ri, li)
  // The chain whose middle points sit higher (smaller y) is the upper lip.
  const meanY = (pts: Point[]) => pts.reduce((s, p) => s + p[1], 0) / pts.length
  const [upper, lower] = meanY(a) <= meanY(b) ? [a, b] : [b, a]
  if (upper.length < 3 || lower.length < 3) {
    // A chain with only the two corners: give it a point on the corner line so it is still a polygon.
    const mid: Point = [(poly[li][0] + poly[ri][0]) / 2, (poly[li][1] + poly[ri][1]) / 2]
    if (upper.length < 3) upper.splice(1, 0, mid)
    if (lower.length < 3) lower.splice(1, 0, mid)
  }
  return { upper, lower, corners: [poly[li], poly[ri]] }
}

/** Mouth frame and lip extents for lips in pixels; `warp` 0..1. Null if the corners are less than 2 px apart. */
export function mouthGeometry(upper: Point[], lower: Point[], corners: [Point, Point] | undefined, warp: number): MouthGeo | null {
  if (upper.length < 3 || lower.length < 3) return null
  let [cl, cr] = corners ?? [0, 1].map((k) => {
    const pick = (pts: Point[]) => pts.reduce((m, p) => ((k ? p[0] > m[0] : p[0] < m[0]) ? p : m))
    const a = pick(upper)
    const b = pick(lower)
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Point
  }) as [Point, Point]
  if (cl[0] > cr[0]) [cl, cr] = [cr, cl]
  const len = Math.hypot(cr[0] - cl[0], cr[1] - cl[1])
  if (!(len >= 2)) return null
  const u: Point = [(cr[0] - cl[0]) / len, (cr[1] - cl[1]) / len]
  const v: Point = [-u[1], u[0]]
  const c: Point = [(cl[0] + cr[0]) / 2, (cl[1] + cr[1]) / 2]
  const half = len / 2
  const loc = (p: Point): Point => [(p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1], (p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1]]
  let up = upper.map(loc)
  let low = lower.map(loc)
  // Lips outlined the wrong way round (the "upper" one lower down in the mouth frame) are swapped, so the upper lip
  // always moves up; this also covers a mouth upside down in the image.
  const meanV = (pts: Point[]) => pts.reduce((s, p) => s + p[1], 0) / pts.length
  if (meanV(up) > meanV(low)) {
    ;[up, low] = [low, up]
    ;[upper, lower] = [lower, upper]
  }
  // Where a line across the mouth at `x` meets a polygon's edges (v values).
  const cross = (pts: Point[], x: number) => {
    const ys: number[] = []
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length]
      if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) ys.push(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]))
    })
    return ys
  }
  const seam = Array.from({ length: SEAM_SAMPLES }, (_, k) => {
    if (k === 0 || k === SEAM_SAMPLES - 1) return 0
    const x = -half + (2 * half * k) / (SEAM_SAMPLES - 1)
    const a = cross(up, x)
    const b = cross(low, x)
    if (a.length && b.length) return (Math.max(...a) + Math.min(...b)) / 2
    return a.length ? Math.max(...a) : b.length ? Math.min(...b) : 0
  })
  const all = [...up, ...low]
  const bx = Math.max(half, ...all.map((p) => Math.abs(p[0])))
  const top = Math.min(...up.map((p) => p[1]), ...low.map((p) => p[1]))
  const bottom = Math.max(...low.map((p) => p[1]), ...up.map((p) => p[1]))
  const mid = seam[(SEAM_SAMPLES - 1) / 2]
  const upTh = Math.max(2, mid - top)
  const lowTh = Math.max(2, bottom - mid)
  const w = clamp(warp, 0, 1)
  return {
    c,
    u,
    v,
    half,
    seam,
    bx,
    top,
    bottom,
    upTh,
    lowTh,
    band: Math.max(0.5, 0.15 * Math.min(upTh, lowTh)),
    radius: w > 0 ? 2 * half * Math.max(0.4, 0.2 + 2.2 * w) : 0,
    pad: 0.7 * half,
    upper,
    lower,
  }
}

/** Seam offset along `v` at frame position `x` (0 beyond the corners). */
export function seamAt(g: MouthGeo, x: number): number {
  const t = ((x + g.half) / (2 * g.half)) * (SEAM_SAMPLES - 1)
  if (!(t > 0 && t < SEAM_SAMPLES - 1)) return 0
  const i = Math.floor(t)
  return lerp(g.seam[i], g.seam[i + 1], t - i)
}

/** Lip motion for opening `open` 0..1 and shape `wide` -1 (round) .. 1 (wide), in px. */
export function mouthMotion(g: MouthGeo, open: number, wide: number): Motion {
  const o = clamp(open, 0, 1)
  const w = clamp(wide, -1, 1)
  const wd = Math.max(0, w)
  const rd = Math.max(0, -w)
  const mw = 2 * g.half
  return {
    up: o * 0.08 * mw,
    low: o * 0.3 * mw * (1 - 0.35 * wd + 0.1 * rd),
    corner: (0.12 * wd - 0.18 * rd) * g.half * (0.5 + 0.5 * o),
    pucker: 0.12 * rd * o,
  }
}

const toLocal = (g: MouthGeo, p: Point): Point => {
  const dx = p[0] - g.c[0]
  const dy = p[1] - g.c[1]
  return [dx * g.u[0] + dy * g.u[1], dx * g.v[0] + dy * g.v[1]]
}
const toImage = (g: MouthGeo, x: number, y: number): Point => [g.c[0] + x * g.u[0] + y * g.v[0], g.c[1] + x * g.u[1] + y * g.v[1]]

/** Distance (px) from a frame point to the box around both lips. */
export const lipDistance = (g: MouthGeo, [x, y]: Point) => Math.hypot(Math.max(0, Math.abs(x) - g.bx), Math.max(0, g.top - y, y - g.bottom))

/**
 * Displacement (image px) of image point `p` for the upper (side 0) or lower (side 1) half of the face: full on the
 * lips, falling off to zero at `radius` from them (immediately when the radius is 0).
 */
export function displace(g: MouthGeo, m: Motion, p: Point, side: 0 | 1): Point {
  const l = toLocal(g, p)
  const d = lipDistance(g, l)
  // Without a face warp only the lips are drawn moved, and they move as a whole.
  const f = g.radius > 0 ? 1 - smoothstep(0, g.radius, d) : 1
  if (f <= 0) return [0, 0]
  const sx = l[0] / g.half
  // Lips open most in the middle and not at the corners; farther from the lips (chin, nose) the shape widens so
  // the jaw moves as a whole instead of a narrow column. Beyond the corners on the seam it stays 0: no tear.
  const tx = l[0] / (g.half + 0.8 * d)
  const taper = Math.max(0, 1 - tx * tx)
  const dx = m.corner * clamp(sx, -1, 1) * f
  const dy = ((side ? m.low : -m.up) * taper + (l[1] - seamAt(g, l[0])) * m.pucker) * f
  return [dx * g.u[0] + dy * g.v[0], dx * g.u[1] + dy * g.v[1]]
}

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]]

/** Columns and rows on a frame grid -> mesh: two triangles per cell, `pos(i, j)` gives the source point. */
function gridMesh(cols: number, rows: number, pos: (i: number, j: number) => Point, move: (p: Point, j: number) => Point): Mesh {
  const src: Point[] = []
  const dst: Point[] = []
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const p = pos(i, j)
      src.push(p)
      dst.push(add(p, move(p, j)))
    }
  const tris: Tri[] = []
  for (let j = 0; j + 1 < rows; j++)
    for (let i = 0; i + 1 < cols; i++) {
      const a = j * cols + i
      tris.push([a, a + 1, a + cols], [a + 1, a + cols + 1, a + cols])
    }
  return { src, dst, tris }
}

/** Frame x positions of the face mesh columns: dense across the mouth, coarser out to the mesh edge. */
function faceColumns(g: MouthGeo): number[] {
  const reach = g.bx + g.radius + g.pad
  const inner = Array.from({ length: 11 }, (_, k) => (g.half * (k - 5)) / 5)
  const outer = [0.25, 0.5, 0.75, 1].map((t) => g.half + (reach - g.half) * t)
  return [...outer.map((x) => -x).reverse(), ...inner, ...outer]
}

/** Rows of the face mesh: `[offset, seam weight, side]`, so row y = offset + weight * seam(x). */
function faceRows(g: MouthGeo): [number, number, 0 | 1][] {
  const vt = g.top - g.radius - g.pad
  const vb = g.bottom + g.radius + g.pad
  return [
    [vt, 0, 0],
    [(vt + g.top) / 2, 0.5, 0],
    [-g.upTh, 1, 0],
    [-g.upTh / 2, 1, 0],
    [-g.band, 1, 0],
    [g.band, 1, 1],
    [g.lowTh / 2, 1, 1],
    [g.lowTh, 1, 1],
    [(g.bottom + vb) / 2, 0.5, 1],
    [vb, 0, 1],
  ]
}

/** Warp mesh of the face around the mouth; its outline (`faceOutline`) never moves. */
export function faceMesh(g: MouthGeo, m: Motion): Mesh {
  const xs = faceColumns(g)
  const rows = faceRows(g)
  return gridMesh(
    xs.length,
    rows.length,
    (i, j) => toImage(g, xs[i], rows[j][0] + rows[j][1] * seamAt(g, xs[i])),
    (p, j) => displace(g, m, p, rows[j][2]),
  )
}

/**
 * The fixed outline of the face mesh (a rectangle in the mouth frame), image px, clockwise from top left; `inset`
 * moves its sides inwards (the base image is cut out a little smaller, so its edge hides under the mesh).
 */
export function faceOutline(g: MouthGeo, inset = 0): Point[] {
  const xs = faceColumns(g)
  const rows = faceRows(g)
  const [x0, x1] = [xs[0] + inset, xs.at(-1)! - inset]
  const [y0, y1] = [rows[0][0] + inset, rows.at(-1)![0] - inset]
  return [toImage(g, x0, y0), toImage(g, x1, y0), toImage(g, x1, y1), toImage(g, x0, y1)]
}

/** Mesh over one lip's box in the mouth frame, moved with that half of the face. */
export function lipMesh(g: MouthGeo, m: Motion, which: 'upper' | 'lower'): Mesh {
  const pts = (which === 'upper' ? g.upper : g.lower).map((p) => toLocal(g, p))
  const b = bboxOf(pts)
  const cols = 11
  const rows = 4
  return gridMesh(
    cols,
    rows,
    (i, j) => toImage(g, lerp(b.x0 - 1, b.x1 + 1, i / (cols - 1)), lerp(b.y0 - 1, b.y1 + 1, j / (rows - 1))),
    (p) => displace(g, m, p, which === 'upper' ? 0 : 1),
  )
}

/** The opening between the lips (upper edge left to right, then lower edge back); zero area when closed. */
export function gapPolygon(g: MouthGeo, m: Motion): Point[] {
  const seam = Array.from({ length: SEAM_SAMPLES }, (_, k) => {
    const x = -g.half + (2 * g.half * k) / (SEAM_SAMPLES - 1)
    return toImage(g, x, seamAt(g, x))
  })
  return [...seam.map((p) => add(p, displace(g, m, p, 0))), ...seam.reverse().map((p) => add(p, displace(g, m, p, 1)))]
}

/** Affine matrix [a, b, c, d, e, f] (canvas order) mapping triangle `s` onto `d`; null when `s` is degenerate. */
export function triAffine(s: [Point, Point, Point], d: [Point, Point, Point]): [number, number, number, number, number, number] | null {
  const [[x0, y0], [x1, y1], [x2, y2]] = s
  const [[u0, v0], [u1, v1], [u2, v2]] = d
  const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
  if (Math.abs(den) < 1e-12) return null
  const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / den
  const c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / den
  const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / den
  const dd = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / den
  return [a, b, c, dd, u0 - a * x0 - c * y0, v0 - b * x0 - dd * y0]
}

/**
 * Triangle whose edges are pushed out by `px` (mitred corners, capped at 3 * px for sharp ones), so neighbours
 * overlap a little and no hairline seams show between them.
 */
export function grow(t: [Point, Point, Point], px: number): [Point, Point, Point] {
  const s = Math.sign(triArea(...t))
  if (!s) return t
  // Outward normal of the edge from a to b (for either winding).
  const normal = (a: Point, b: Point): Point => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [(s * (b[1] - a[1])) / l, (-s * (b[0] - a[0])) / l]
  }
  return t.map((p, i) => {
    const n1 = normal(t[(i + 2) % 3], p)
    const n2 = normal(p, t[(i + 1) % 3])
    const mx = n1[0] + n2[0]
    const my = n1[1] + n2[1]
    const ml = Math.hypot(mx, my) || 1
    const cos = (mx * n1[0] + my * n1[1]) / ml
    const len = Math.min(3 * px, px / Math.max(cos, 1e-6))
    return [p[0] + (mx / ml) * len, p[1] + (my / ml) * len] as Point
  }) as [Point, Point, Point]
}

/** Signed area of a triangle (positive = clockwise on screen). */
export const triArea = (a: Point, b: Point, c: Point) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2

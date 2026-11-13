// Pure polygon and bitmap helpers for the mask editor. Polygons are closed (last point connects to the first);
// units are whatever the caller uses (working-bitmap pixels in the editor, 0..1 in the rig).
import type { Point } from './rig'

export const MAX_MASK_POINTS = 4096

/** Shoelace area; positive for clockwise polygons in screen coordinates (y down). */
export function polygonArea(p: Point[]): number {
  let a = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]
  return a / 2
}

export const isClockwise = (p: Point[]) => polygonArea(p) > 0

export function perimeter(p: Point[]): number {
  let s = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1])
  return s
}

/** Even-odd rule. */
export function pointInPolygon([x, y]: Point, p: Point[]): boolean {
  let inside = false
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i]
    const [xj, yj] = p[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Chaikin corner cutting; stops early instead of exceeding `max` points. */
export function chaikin(p: Point[], iterations: number, max = MAX_MASK_POINTS): Point[] {
  let out = p.slice()
  for (let k = 0; k < iterations && out.length >= 3 && out.length * 2 <= max; k++) {
    const next: Point[] = []
    for (let i = 0; i < out.length; i++) {
      const [ax, ay] = out[i]
      const [bx, by] = out[(i + 1) % out.length]
      next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75])
    }
    out = next
  }
  return out
}

export function distToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

/** Douglas-Peucker on an open chain (endpoints kept), iterative so long outlines cannot overflow the stack. */
function dpOpen(p: Point[], eps: number): Point[] {
  if (p.length <= 2) return p.slice()
  const keep = new Uint8Array(p.length)
  keep[0] = keep[p.length - 1] = 1
  const stack: [number, number][] = [[0, p.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let md = -1
    let mi = -1
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(p[i], p[a], p[b])
      if (d > md) [md, mi] = [d, i]
    }
    if (mi >= 0 && md > eps) {
      keep[mi] = 1
      stack.push([a, mi], [mi, b])
    }
  }
  return p.filter((_, i) => keep[i])
}

/** Douglas-Peucker for a closed polygon: split at the point farthest from the first, simplify both halves. */
export function douglasPeucker(p: Point[], eps: number): Point[] {
  if (p.length <= 3) return p.slice()
  let far = 0
  let fd = 0
  for (let i = 1; i < p.length; i++) {
    const d = Math.hypot(p[i][0] - p[0][0], p[i][1] - p[0][1])
    if (d > fd) [fd, far] = [d, i]
  }
  if (!fd) return [p[0]]
  const a = dpOpen(p.slice(0, far + 1), eps)
  const b = dpOpen([...p.slice(far), p[0]], eps)
  return [...a, ...b.slice(1, -1)]
}

/** Douglas-Peucker with the tolerance raised until at most `max` points remain. */
export function simplifyTo(p: Point[], eps: number, max = MAX_MASK_POINTS): Point[] {
  let e = eps
  let out = douglasPeucker(p, e)
  while (out.length > max) {
    e = e > 0 ? e * 1.5 : 1e-6
    out = douglasPeucker(p, e)
  }
  return out
}

/**
 * Smoothing for the "Smooth" slider: `amount` 0..1 gives up to 3 Chaikin passes, then Douglas-Peucker with a
 * tolerance of (0.25 + amount) `unit`s (one working-bitmap pixel). Amount 0 only drops exactly collinear points.
 */
export function smoothPolygon(p: Point[], amount: number, unit = 1, max = MAX_MASK_POINTS): Point[] {
  if (p.length < 3) return p.slice()
  const a = Math.min(1, Math.max(0, amount))
  return simplifyTo(chaikin(p, Math.ceil(a * 3), max), a ? (0.25 + a) * unit : 0, max)
}

/** `n` points evenly spaced by arc length along the closed outline. */
export function resample(p: Point[], n: number): Point[] {
  const per = perimeter(p)
  if (p.length < 2 || n < 1 || !per) return p.slice()
  const out: Point[] = []
  let seg = 0
  let start = 0
  let len = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1])
  for (let k = 0; k < n; k++) {
    const t = (k * per) / n
    while (start + len < t && seg < p.length - 1) {
      start += len
      seg++
      const b = p[(seg + 1) % p.length]
      len = Math.hypot(b[0] - p[seg][0], b[1] - p[seg][1])
    }
    const a = p[seg]
    const b = p[(seg + 1) % p.length]
    const f = len ? (t - start) / len : 0
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
  }
  return out
}

// Moore neighbourhood, clockwise on screen starting west.
const DIRS: Point[] = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]]
const dirIndex = (dx: number, dy: number) => DIRS.findIndex(([x, y]) => x === dx && y === dy)

/**
 * Outer contour of the largest 8-connected foreground region of a w*h bitmap (non-zero = foreground), traced with
 * Moore-neighbour tracing; it stops when the first move (start -> second pixel) repeats, so pinch points through
 * the start pixel are handled. Returns pixel centres, clockwise on screen; holes are ignored.
 */
export function traceLargest(mask: Uint8Array, w: number, h: number): Point[] {
  const label = new Int32Array(w * h)
  let best = 0
  let bestSize = 0
  let bestStart = -1
  const queue = new Int32Array(w * h)
  for (let s = 0, id = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue
    label[s] = ++id
    let head = 0
    let tail = 0
    queue[tail++] = s
    while (head < tail) {
      const i = queue[head++]
      const x = i % w
      const y = (i - x) / w
      for (const [dx, dy] of DIRS) {
        const nx = x + dx
        const ny = y + dy
        const j = ny * w + nx
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[j] && !label[j]) {
          label[j] = id
          queue[tail++] = j
        }
      }
    }
    // Scan order makes `s` the topmost-leftmost pixel of its region, so its west neighbour is background.
    if (tail > bestSize) [best, bestSize, bestStart] = [id, tail, s]
  }
  if (bestStart < 0) return []
  const fg = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === best
  const sx = bestStart % w
  const sy = (bestStart - sx) / w
  const out: Point[] = []
  let [cx, cy] = [sx, sy]
  let [bx, by] = [sx - 1, sy]
  let second: Point | null = null
  for (let guard = 0; guard < 8 * w * h + 8; guard++) {
    const from = dirIndex(bx - cx, by - cy)
    let next: Point | null = null
    for (let k = 1; k <= 8 && !next; k++) {
      const [dx, dy] = DIRS[(from + k) % 8]
      if (fg(cx + dx, cy + dy)) {
        const [px, py] = DIRS[(from + k + 7) % 8]
        ;[bx, by] = [cx + px, cy + py]
        next = [cx + dx, cy + dy]
      }
    }
    if (cx === sx && cy === sy && second && next && next[0] === second[0] && next[1] === second[1]) break
    out.push([cx + 0.5, cy + 0.5])
    if (!next) break // single pixel
    second ??= next
    ;[cx, cy] = next
  }
  return out
}

/** Magic wand: 4-connected region around (sx, sy) whose RGB differs from the seed by at most `tolerance` (0..1). */
export function floodSelect(rgba: ArrayLike<number>, w: number, h: number, sx: number, sy: number, tolerance: number): Uint8Array {
  const out = new Uint8Array(w * h)
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out
  const s = (sy * w + sx) * 4
  const lim = tolerance * 255
  const near = (i: number) =>
    Math.abs(rgba[i * 4] - rgba[s]) <= lim && Math.abs(rgba[i * 4 + 1] - rgba[s + 1]) <= lim && Math.abs(rgba[i * 4 + 2] - rgba[s + 2]) <= lim
  const stack = [sy * w + sx]
  out[stack[0]] = 1
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w])
      if (j >= 0 && j < w * h && !out[j] && near(j)) {
        out[j] = 1
        stack.push(j)
      }
  }
  return out
}

/** Sobel gradient magnitude at pixel (x, y) of a w*h grayscale image (edges clamped). */
export function sobel(gray: (x: number, y: number) => number, w: number, h: number, x: number, y: number): number {
  const g = (i: number, j: number) => gray(Math.min(w - 1, Math.max(0, i)), Math.min(h - 1, Math.max(0, j)))
  const gx = g(x + 1, y - 1) + 2 * g(x + 1, y) + g(x + 1, y + 1) - g(x - 1, y - 1) - 2 * g(x - 1, y) - g(x - 1, y + 1)
  const gy = g(x - 1, y + 1) + 2 * g(x, y + 1) + g(x + 1, y + 1) - g(x - 1, y - 1) - 2 * g(x, y - 1) - g(x + 1, y - 1)
  return Math.hypot(gx, gy)
}

/** Circular median (window 5) then three circular moving averages (window 5): neighbours move together. */
function regularise(d: Float64Array): Float64Array {
  const n = d.length
  const at = (a: Float64Array, i: number) => a[(i + n) % n]
  let cur = d.map((_, i) => [-2, -1, 0, 1, 2].map((k) => at(d, i + k)).sort((a, b) => a - b)[2])
  for (let pass = 0; pass < 3; pass++) {
    const prev = cur
    cur = prev.map((_, i) => (at(prev, i - 2) + at(prev, i - 1) + at(prev, i) + at(prev, i + 1) + at(prev, i + 2)) / 5)
  }
  return cur
}

/**
 * Edge snap: resamples the outline every `spacing` pixels, moves each point along its normal (up to `radius`
 * pixels either way) to the strongest Sobel gradient, preferring nearer edges, smooths the displacements along the
 * outline and clamps to the image. `gray(x, y)` reads integer pixels of a w*h grayscale image.
 */
export function snapToGradient(
  p: Point[],
  gray: (x: number, y: number) => number,
  w: number,
  h: number,
  radius: number,
  spacing = 2,
): Point[] {
  const r = Math.round(radius)
  if (p.length < 3 || r < 1 || !perimeter(p)) return p.slice()
  const n = Math.max(8, Math.min(2048, Math.round(perimeter(p) / spacing)))
  const q = resample(p, n)
  const normals = q.map((_, i): Point => {
    const [ax, ay] = q[(i - 1 + n) % n]
    const [bx, by] = q[(i + 1) % n]
    const l = Math.hypot(bx - ax, by - ay)
    return l ? [(by - ay) / l, -(bx - ax) / l] : [0, 0]
  })
  const disp = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const [x0, y0] = q[i]
    const [nx, ny] = normals[i]
    let bestScore = 1e-6
    for (let k = 0; k <= 2 * r; k++) {
      const d = k % 2 ? (k + 1) / 2 : -k / 2 // 0, 1, -1, 2, -2, …: ties go to the nearer offset
      const x = Math.round(x0 + nx * d - 0.5)
      const y = Math.round(y0 + ny * d - 0.5)
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      const score = sobel(gray, w, h, x, y) * (1 - (0.5 * Math.abs(d)) / (r + 1))
      if (score > bestScore) [bestScore, disp[i]] = [score, d]
    }
  }
  const sm = regularise(disp)
  return q.map(([x, y], i): Point => [
    Math.min(w, Math.max(0, x + normals[i][0] * sm[i])),
    Math.min(h, Math.max(0, y + normals[i][1] * sm[i])),
  ])
}

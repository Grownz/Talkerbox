// "Background under moved parts": which area a moving part leaves behind, and how it is filled. Pure (typed arrays),
// tested in tests/fillUnder.test.ts; rigRender.ts turns the result into a cached base texture once per rig load.
//
// Region: arms and legs turn about their pivots, and every part hanging on one (hands) moves with it. Wherever such a
// part sits in the image, the base layer shows the part itself, so the part is drawn there twice once it moves. The
// region to fill is therefore the union of these polygons (independent of the current angle, so it is computed once;
// the swept area outside the polygon is always covered by the moved part). Eyes (squashed over their lid colour) and
// the mouth (filled or warped in place) do not move and are not part of it.
//
// Classic fill: push-pull (pyramid) interpolation on premultiplied RGBA. Known pixels are averaged down a pyramid and
// pulled back into the hole with bilinear upsampling, giving a smooth membrane-like fill in O(pixels). Pixels outside
// the mask count as known and transparent, so a hole that reaches the outline fades to transparent instead of
// smearing the original background in. shortcut: smooth fill, no texture synthesis; the AI fill (LaMa) is the option
// for patterned backgrounds.
import type { FillMode, Point, PartRole } from './rig.ts'

const LIMBS: PartRole[] = ['armL', 'armR', 'legL', 'legR']

/** Ids of the parts that move: limbs and every part attached (directly or not) to one. */
export function movingParts(parts: { id: string; role: PartRole; parent?: string }[]): Set<string> {
  const byId = new Map(parts.map((p) => [p.id, p]))
  const out = new Set<string>()
  for (const p of parts) {
    let cur: (typeof parts)[number] | undefined = p
    for (let steps = 0; cur && steps <= parts.length; steps++) {
      if (LIMBS.includes(cur.role)) {
        out.add(p.id)
        break
      }
      cur = cur.parent === undefined ? undefined : byId.get(cur.parent)
    }
  }
  return out
}

/** Polygons (normalised) of the moving parts: the area the base layer must not show as it is. */
export function fillPolygons(parts: { id: string; role: PartRole; parent?: string; polygon: Point[] }[]): Point[][] {
  const ids = movingParts(parts)
  return parts.filter((p) => ids.has(p.id) && p.polygon.length >= 3).map((p) => p.polygon)
}

/** Short signature of the fill region (the moving polygons), to tell whether a stored AI fill is still current. */
export function regionSig(polys: Point[][]): string {
  let h = 0x811c9dc5
  for (const c of JSON.stringify(polys.map((p) => p.map(([x, y]) => [Math.round(x * 1e4), Math.round(y * 1e4)])))) {
    h ^= c.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Union of polygons (normalised) as a w*h mask: a pixel is inside when its centre is (even-odd per polygon). */
export function rasterize(polys: Point[][], w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h)
  for (const poly of polys) {
    const pts = poly.map(([x, y]): Point => [x * w, y * h])
    for (let y = 0; y < h; y++) {
      const cy = y + 0.5
      const xs: number[] = []
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [x0, y0] = pts[j]
        const [x1, y1] = pts[i]
        if (y0 <= cy !== y1 <= cy) xs.push(x0 + ((cy - y0) / (y1 - y0)) * (x1 - x0))
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil(xs[k] - 0.5))
        const b = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5))
        for (let x = a; x <= b; x++) m[y * w + x] = 1
      }
    }
  }
  return m
}

/** Grows a mask by `r` pixels (4-neighbour steps), so the fill also covers the anti-aliased edge of the parts. */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let cur = mask
  for (let k = 0; k < r; k++) {
    const next = cur.slice()
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (cur[i]) continue
        if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])) next[i] = 1
      }
    cur = next
  }
  return cur
}

/** Bounding box [x0, y0, x1, y1) of the set pixels, grown by `margin` and clamped; null for an empty mask. */
export function maskBox(mask: Uint8Array, w: number, h: number, margin = 0): [number, number, number, number] | null {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) return null
  return [Math.max(0, x0 - margin), Math.max(0, y0 - margin), Math.min(w, x1 + 1 + margin), Math.min(h, y1 + 1 + margin)]
}

/**
 * Fills the hole pixels of a w*h RGBA image (straight alpha) by push-pull interpolation of the known pixels, in place.
 * Only the hole's bounding box plus a margin is processed.
 */
export function pushPull(rgba: Uint8ClampedArray, hole: Uint8Array, w: number, h: number) {
  const box = maskBox(hole, w, h, 0)
  if (!box) return
  const margin = Math.max(8, Math.round(0.5 * Math.max(box[2] - box[0], box[3] - box[1])))
  const [bx0, by0, bx1, by1] = [Math.max(0, box[0] - margin), Math.max(0, box[1] - margin), Math.min(w, box[2] + margin), Math.min(h, box[3] + margin)]
  const cw = bx1 - bx0
  const ch = by1 - by0
  // Level 0: premultiplied RGBA (0..1) and the weight (1 = known).
  type Level = { w: number; h: number; c: Float32Array; a: Float32Array }
  const l0: Level = { w: cw, h: ch, c: new Float32Array(cw * ch * 4), a: new Float32Array(cw * ch) }
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x
      const s = (y + by0) * w + (x + bx0)
      if (hole[s]) continue
      const al = rgba[s * 4 + 3] / 255
      l0.c[i * 4] = (rgba[s * 4] / 255) * al
      l0.c[i * 4 + 1] = (rgba[s * 4 + 1] / 255) * al
      l0.c[i * 4 + 2] = (rgba[s * 4 + 2] / 255) * al
      l0.c[i * 4 + 3] = al
      l0.a[i] = 1
    }
  // Push: average the known values down to coarser levels.
  const levels = [l0]
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const f = levels.at(-1)!
    const nw = Math.ceil(f.w / 2)
    const nh = Math.ceil(f.h / 2)
    const n: Level = { w: nw, h: nh, c: new Float32Array(nw * nh * 4), a: new Float32Array(nw * nh) }
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        let sa = 0
        const sc = [0, 0, 0, 0]
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const fx = 2 * x + dx
            const fy = 2 * y + dy
            if (fx >= f.w || fy >= f.h) continue
            const j = fy * f.w + fx
            const wt = f.a[j]
            sa += wt
            for (let k = 0; k < 4; k++) sc[k] += wt * f.c[j * 4 + k]
          }
        const i = y * nw + x
        if (sa > 0) for (let k = 0; k < 4; k++) n.c[i * 4 + k] = sc[k] / sa
        n.a[i] = Math.min(1, sa)
      }
    levels.push(n)
  }
  // Pull: blend each level's partly known pixels with the bilinear upsampling of the level below.
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l]
    const c = levels[l + 1]
    for (let y = 0; y < f.h; y++)
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x
        const wt = f.a[i]
        if (wt >= 1) continue
        const gx = Math.min(c.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5))
        const gy = Math.min(c.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5))
        const x0 = Math.floor(gx)
        const y0 = Math.floor(gy)
        const x1 = Math.min(c.w - 1, x0 + 1)
        const y1 = Math.min(c.h - 1, y0 + 1)
        const tx = gx - x0
        const ty = gy - y0
        for (let k = 0; k < 4; k++) {
          const v =
            (c.c[(y0 * c.w + x0) * 4 + k] * (1 - tx) + c.c[(y0 * c.w + x1) * 4 + k] * tx) * (1 - ty) +
            (c.c[(y1 * c.w + x0) * 4 + k] * (1 - tx) + c.c[(y1 * c.w + x1) * 4 + k] * tx) * ty
          f.c[i * 4 + k] = wt * f.c[i * 4 + k] + (1 - wt) * v
        }
        f.a[i] = 1
      }
  }
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const s = (y + by0) * w + (x + bx0)
      if (!hole[s]) continue
      const i = y * cw + x
      const al = l0.c[i * 4 + 3]
      for (let k = 0; k < 3; k++) rgba[s * 4 + k] = al > 1e-4 ? (l0.c[i * 4 + k] / al) * 255 : 0
      rgba[s * 4 + 3] = al * 255
    }
}

/**
 * Base layer pixels for a fill mode, in place on the RGBA image within the mask (straight alpha): `transparent` clears
 * the hole, `classic` and `ai` fill it with push-pull (the AI colours are laid over that later, keeping its alpha).
 */
export function applyFill(rgba: Uint8ClampedArray, hole: Uint8Array, w: number, h: number, mode: FillMode) {
  if (mode === 'none') return
  if (mode === 'transparent') {
    for (let i = 0; i < hole.length; i++) if (hole[i]) rgba[i * 4 + 3] = 0
    return
  }
  pushPull(rgba, hole, w, h)
}

/** Overlays AI colours (RGB of an equally sized image) on the hole pixels, keeping the base's (classic) alpha. */
export function overlayColours(rgba: Uint8ClampedArray, colours: Uint8ClampedArray, hole: Uint8Array) {
  for (let i = 0; i < hole.length; i++) if (hole[i] && colours[i * 4 + 3] > 0) for (let k = 0; k < 3; k++) rgba[i * 4 + k] = colours[i * 4 + k]
}

/**
 * Square-ish crop (image pixels [x0, y0, x1, y1)) around the fill region of a W*H image for the 512 px AI model: the
 * region's box plus half its size of context on each side (at least 32 px), widened to a square where the image allows.
 * Null without a region.
 */
export function fillCrop(polys: Point[][], W: number, H: number): [number, number, number, number] | null {
  const pts = polys.flat()
  if (!pts.length) return null
  let x0 = Math.min(...pts.map((p) => p[0])) * W
  let x1 = Math.max(...pts.map((p) => p[0])) * W
  let y0 = Math.min(...pts.map((p) => p[1])) * H
  let y1 = Math.max(...pts.map((p) => p[1])) * H
  const m = Math.max(32, 0.5 * Math.max(x1 - x0, y1 - y0))
  ;[x0, y0, x1, y1] = [x0 - m, y0 - m, x1 + m, y1 + m]
  const side = Math.max(x1 - x0, y1 - y0)
  const grow = (a: number, b: number, max: number): [number, number] => {
    const c = (a + b) / 2
    let lo = c - side / 2
    let hi = c + side / 2
    if (lo < 0) [lo, hi] = [0, hi - lo]
    if (hi > max) [lo, hi] = [Math.max(0, lo - (hi - max)), max]
    return [Math.floor(lo), Math.ceil(hi)]
  }
  ;[x0, x1] = grow(x0, x1, W)
  ;[y0, y1] = grow(y0, y1, H)
  return [x0, y0, Math.min(W, x1), Math.min(H, y1)]
}

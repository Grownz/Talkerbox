// Canvas renderer for a rigged character (part editor preview and avatar window) and its pure maths.
// Parts are cut from the source image (part polygon within the mask) and drawn transformed about their pivots on top
// of the base image. With `rig.fill` the area moving parts uncover is cut out or filled in the base layer, which is
// computed once per load (`baseLayer`); with mode `none` it keeps the original pixels.
import { applyFill, dilate, fillPolygons, movingParts, overlayColours, rasterize } from './fillUnder.ts'
import { resample } from './maskGeometry.ts'
import { faceMesh, faceOutline, gapPolygon, grow, lipMesh, mouthGeometry, mouthMotion, triAffine, type Mesh, type MouthGeo, type Motion } from './mouthWarp.ts'
import { DEFAULT_WARP, maskOutline, type PartRole, type Point, type Rig, type RigPart } from './rig.ts'

/**
 * Animation state: `mouth` and `blink` 0..1, `wide` the mouth shape (-1 round .. 1 wide, viseme.ts), limb angles and
 * `sway` in degrees (positive = clockwise).
 */
export interface Pose {
  mouth: number
  wide: number
  blink: number
  armL: number
  armR: number
  legL: number
  legR: number
  sway: number
}
export const REST: Pose = { mouth: 0, wide: 0, blink: 0, armL: 0, armR: 0, legL: 0, legR: 0, sway: 0 }
export const LIMB_ROLES = ['armL', 'armR', 'legL', 'legR'] as const
export const DEFAULT_LID = '#d9a882'
export const DEFAULT_MOUTH = '#3a1016'

/** 2D affine matrix in canvas order [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = [number, number, number, number, number, number]
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

/** m * n: applies n first, then m. */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}
export const apply = (m: Mat, [x, y]: Point): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
export function rotateAbout(deg: number, [px, py]: Point): Mat {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [c, s, -s, c, px - c * px + s * py, py - s * px - c * py]
}
export const scaleAbout = (sx: number, sy: number, [px, py]: Point): Mat => [sx, 0, 0, sy, px - sx * px, py - sy * py]
export const isIdentity = (m: Mat) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9)

export function bbox(pts: Point[]) {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}
const centre = (pts: Point[]): Point => {
  const b = bbox(pts)
  return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]
}

/**
 * Pivot a new part starts with: arms, hands and legs turn about the middle of their top end (shoulder, wrist, hip
 * for a figure standing upright); everything else about the centre of its bounding box.
 */
export function defaultPivot(role: PartRole, polygon: Point[]): Point {
  if (!polygon.length) return [0.5, 0.5]
  const b = bbox(polygon)
  const cx = (b.x0 + b.x1) / 2
  return /^(arm|hand|leg)/.test(role) ? [cx, b.y0 + (b.y1 - b.y0) * 0.08] : [cx, (b.y0 + b.y1) / 2]
}

/** The pose angle that turns a part of this role (hands only follow their parent). */
export const poseAngle = (role: PartRole, pose: Pose) => ((LIMB_ROLES as readonly string[]).includes(role) ? pose[role as (typeof LIMB_ROLES)[number]] : 0)

/** Transform of a part in image pixels (w*h): its own rotation about its pivot, then its parents'. */
export function partMatrix(parts: RigPart[], part: RigPart, pose: Pose, w: number, h: number): Mat {
  let m = IDENTITY
  let cur: RigPart | undefined = part
  for (let depth = 0; cur && depth <= parts.length; depth++) {
    m = mul(rotateAbout(poseAngle(cur.role, pose), [cur.pivot[0] * w, cur.pivot[1] * h]), m)
    const parent: string | undefined = cur.parent
    cur = parent === undefined ? undefined : parts.find((q) => q.id === parent)
  }
  return m
}

/** Blink: squashes the eye vertically toward its centre line `cy` (closed 0..1). */
export const blinkMatrix = (cy: number, closed: number): Mat => scaleAbout(1, 1 - Math.min(1, Math.max(0, closed)), [0, cy])

export const scalePolygon = (pts: Point[], sx: number, sy: number, about: Point) => pts.map((p) => apply(scaleAbout(sx, sy, about), p))

/**
 * Open-mouth area for opening `open` (0..1): the stored open shape scaled vertically about its centre, or without one
 * a shrunk copy of the mouth polygon (80 % wide, up to 70 % high). The viseme shape `wide` (-1..1) makes it up to
 * 20 % wider or narrower (and a wide one a little flatter). Null when closed or without a mouth part.
 */
export function mouthOpenPolygon(rig: Pick<Rig, 'parts' | 'mouth'>, open: number, wide = 0): Point[] | null {
  const m = Math.min(1, Math.max(0, open))
  const part = rig.parts.find((p) => p.role === 'mouth')
  if (!part || m <= 0) return null
  const w = Math.min(1, Math.max(-1, wide || 0))
  const sx = 1 + 0.2 * w
  const sy = 1 - 0.3 * Math.max(0, w)
  const inner = rig.mouth?.interior
  if (inner && inner.length >= 3) return scalePolygon(inner, sx, m * sy, centre(inner))
  return scalePolygon(part.polygon, 0.8 * sx, 0.7 * m * sy, centre(part.polygon))
}

/** Lip geometry of a rig in the pixels of a w*h drawing; null without a mouth part and both lips. */
export function rigMouthGeo(rig: Pick<Rig, 'parts' | 'mouth'>, w: number, h: number): MouthGeo | null {
  const m = rig.mouth
  if (!m?.lipUpper || !m.lipLower || !rig.parts.some((p) => p.role === 'mouth')) return null
  const px = (pts: Point[]) => pts.map(([x, y]): Point => [x * w, y * h])
  return mouthGeometry(px(m.lipUpper), px(m.lipLower), m.corners && (px(m.corners) as [Point, Point]), m.warp ?? DEFAULT_WARP)
}

/** Average colour (`#rrggbb`) just outside a polygon (pixel units of the w*h RGBA image), e.g. the skin around an eye. */
export function sampleRing(rgba: ArrayLike<number>, w: number, h: number, polygon: Point[]): string | null {
  if (polygon.length < 3) return null
  const c = centre(polygon)
  const sum = [0, 0, 0]
  let n = 0
  for (const [x, y] of resample(polygon, 64)) {
    const dx = x - c[0]
    const dy = y - c[1]
    const l = Math.hypot(dx, dy) || 1
    // 15 % farther out plus 2 px, so the sample lands beside the outline, not on it.
    const px = Math.round(x + dx * 0.15 + (dx / l) * 2)
    const py = Math.round(y + dy * 0.15 + (dy / l) * 2)
    if (px < 0 || py < 0 || px >= w || py >= h) continue
    const i = (py * w + px) * 4
    for (let k = 0; k < 3; k++) sum[k] += rgba[i + k]
    n++
  }
  if (!n) return null
  return '#' + sum.map((v) => Math.round(v / n).toString(16).padStart(2, '0')).join('')
}

const isEye = (r: PartRole) => r === 'eyeL' || r === 'eyeR'

function trace(ctx: CanvasRenderingContext2D, pts: Point[], w: number, h: number) {
  ctx.beginPath()
  for (const [x, y] of pts) ctx.lineTo(x * w, y * h)
  ctx.closePath()
}

/** Textures of a rig cut once (base within the mask, each part within mask and outline), drawn at w*h. */
export interface RigSprites {
  base: CanvasImageSource
  parts: Map<string, { img: CanvasImageSource; x: number; y: number; lid?: CanvasImageSource }>
}

/** A cw*ch canvas showing the w*h drawing of `src` from (x, y), within every (normalised) clip polygon, or a fill. */
function cut(src: CanvasImageSource, w: number, h: number, x: number, y: number, cw: number, ch: number, clip: Point[][], fill?: string) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, cw)
  c.height = Math.max(1, ch)
  const g = c.getContext('2d')!
  g.translate(-x, -y)
  for (const pts of clip) {
    trace(g, pts, w, h)
    g.clip()
  }
  if (fill) {
    g.fillStyle = fill
    g.fillRect(x, y, cw, ch)
  } else g.drawImage(src, 0, 0, w, h)
  return c
}

type Tex = { img: HTMLCanvasElement; x: number; y: number }
interface MouthTex {
  key: string
  rig: Rig
  w: number
  h: number
  geo: MouthGeo
  /** Base texture around the mouth for the face warp (null with warp 0), and the two lips. */
  face: Tex | null
  upper: Tex
  lower: Tex
}
// Lip and face textures are cut once per source image and lip definition, in the editor preview as well.
const mouthCache = new WeakMap<object, MouthTex>()

function mouthTextures(rig: Rig, src: CanvasImageSource, w: number, h: number): MouthTex | null {
  const m = rig.mouth
  if (!m?.lipUpper || !m.lipLower || !rig.parts.some((p) => p.role === 'mouth')) return null
  const hit = mouthCache.get(src as object)
  if (hit?.rig === rig && hit.w === w && hit.h === h) return hit // same rig object: no need to compare its data
  const outline = maskOutline(rig)
  const key = JSON.stringify([m.lipUpper, m.lipLower, m.corners, m.warp, outline, w, h])
  if (hit?.key === key) {
    hit.rig = rig
    return hit
  }
  const geo = rigMouthGeo(rig, w, h)
  if (!geo) return null
  const clip = outline ? [outline] : []
  const tex = (pts: Point[], poly?: Point[]): Tex => {
    const b = bbox(pts)
    const x = Math.max(0, Math.floor(b.x0))
    const y = Math.max(0, Math.floor(b.y0))
    const cw = Math.min(w, Math.ceil(b.x1)) - x
    const ch = Math.min(h, Math.ceil(b.y1)) - y
    return { img: cut(src, w, h, x, y, cw, ch, poly ? [...clip, poly] : clip), x, y }
  }
  // The lips from the geometry (pixels), which puts lips outlined the wrong way round in order.
  const lip = (pts: Point[]) => tex(pts, pts.map(([x, y]): Point => [x / w, y / h]))
  const t: MouthTex = {
    key,
    rig,
    w,
    h,
    geo,
    face: geo.radius > 0 ? tex(faceOutline(geo)) : null,
    upper: lip(geo.upper),
    lower: lip(geo.lower),
  }
  mouthCache.set(src as object, t)
  return t
}

/**
 * Draws `tex` through every mesh triangle with its affine map; triangles grow by ~0.75 device px against seams. Each
 * triangle blits only the texture pixels under it (plus a margin), not the whole texture, which keeps the ~450
 * triangles of a large face cheap.
 */
function drawMesh(ctx: CanvasRenderingContext2D, tex: Tex, mesh: Mesh) {
  const t = ctx.getTransform()
  const growBy = 0.75 / (Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) || 1)
  for (const [a, b, c] of mesh.tris) {
    const m = triAffine([mesh.src[a], mesh.src[b], mesh.src[c]], [mesh.dst[a], mesh.dst[b], mesh.dst[c]])
    if (!m) continue
    const [p, q, r] = grow([mesh.dst[a], mesh.dst[b], mesh.dst[c]], growBy)
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(...p)
    ctx.lineTo(...q)
    ctx.lineTo(...r)
    ctx.closePath()
    ctx.clip()
    ctx.transform(...m)
    const s = [mesh.src[a], mesh.src[b], mesh.src[c]]
    const x0 = Math.max(tex.x, Math.floor(Math.min(...s.map((v) => v[0]))) - 4)
    const y0 = Math.max(tex.y, Math.floor(Math.min(...s.map((v) => v[1]))) - 4)
    const x1 = Math.min(tex.x + tex.img.width, Math.ceil(Math.max(...s.map((v) => v[0]))) + 4)
    const y1 = Math.min(tex.y + tex.img.height, Math.ceil(Math.max(...s.map((v) => v[1]))) + 4)
    if (x1 > x0 && y1 > y0) ctx.drawImage(tex.img, x0 - tex.x, y0 - tex.y, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0)
    ctx.restore()
  }
}

/** Lip-driven mouth: warped face around it, the opening in the mouth colour, then both lips over it. */
function drawLips(ctx: CanvasRenderingContext2D, t: MouthTex, motion: Motion, colour: string) {
  if (t.face) drawMesh(ctx, t.face, faceMesh(t.geo, motion))
  ctx.beginPath()
  for (const p of gapPolygon(t.geo, motion)) ctx.lineTo(...p)
  ctx.closePath()
  ctx.fillStyle = colour
  ctx.fill()
  drawMesh(ctx, t.lower, lipMesh(t.geo, motion, 'lower'))
  drawMesh(ctx, t.upper, lipMesh(t.geo, motion, 'upper'))
}

// Base layers with the fill applied, computed once per source image, size, fill and geometry.
const baseCache = new WeakMap<object, { key: string; fillImage: CanvasImageSource | null; canvas: HTMLCanvasElement | null }>()

/**
 * The base layer (image within the mask) with the area under moving parts cut out or filled per `rig.fill`, for a
 * w*h drawing (computed at most 2048 px on the long side; draw it scaled to w*h); null when nothing changes (mode `none` or no moving part). The AI image (`fillImage`, covering `rig.fill.rect`)
 * colours the classic fill; without it mode `ai` falls back to the classic fill.
 */
export function baseLayer(rig: Rig, src: CanvasImageSource, w: number, h: number, fillImage?: CanvasImageSource | null): HTMLCanvasElement | null {
  const mode = rig.fill?.mode ?? 'none'
  const polys = mode === 'none' ? [] : fillPolygons(rig.parts)
  if (!polys.length) return null
  const outline = maskOutline(rig)
  const key = JSON.stringify([mode, rig.fill?.rect, polys, outline, w, h])
  const hit = baseCache.get(src as object)
  const img = mode === 'ai' && rig.fill?.rect ? (fillImage ?? null) : null
  if (hit && hit.key === key && hit.fillImage === img) return hit.canvas
  // shortcut: the editor draws full-size images (up to 8192 px); the fill is computed at 2048 px at most there.
  const s = Math.min(1, 2048 / Math.max(w, h))
  ;[w, h] = [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]
  const c = cut(src, w, h, 0, 0, w, h, outline ? [outline] : [])
  const g = c.getContext('2d', { willReadFrequently: true })!
  const data = g.getImageData(0, 0, w, h)
  // Grown by 2 px so the fill also covers the anti-aliased edge of the parts drawn over it.
  const hole = dilate(rasterize(polys, w, h), w, h, 2)
  applyFill(data.data, hole, w, h, mode === 'ai' ? 'classic' : mode)
  if (img && rig.fill?.rect) {
    const [x0, y0, x1, y1] = rig.fill.rect
    const t = document.createElement('canvas')
    t.width = w
    t.height = h
    const tg = t.getContext('2d', { willReadFrequently: true })!
    tg.imageSmoothingQuality = 'high'
    tg.drawImage(img, x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h)
    overlayColours(data.data, tg.getImageData(0, 0, w, h).data, hole)
  }
  g.putImageData(data, 0, 0)
  baseCache.set(src as object, { key, fillImage: img, canvas: c })
  return c
}

/** Cuts the textures for `drawRig` once per rig load, so each frame only transforms and blits (avatar window). */
export function rigSprites(rig: Rig, src: CanvasImageSource, w: number, h: number, fillImage?: CanvasImageSource | null): RigSprites {
  const outline = maskOutline(rig)
  const layer = (x: number, y: number, cw: number, ch: number, clip: Point[][], fill?: string) => cut(src, w, h, x, y, cw, ch, clip, fill)
  const parts: RigSprites['parts'] = new Map()
  for (const p of rig.parts) {
    const b = bbox(p.polygon)
    const x = Math.floor(b.x0 * w)
    const y = Math.floor(b.y0 * h)
    const cw = Math.ceil(b.x1 * w) - x
    const ch = Math.ceil(b.y1 * h) - y
    const clip = outline ? [outline, p.polygon] : [p.polygon]
    parts.set(p.id, { img: layer(x, y, cw, ch, clip), x, y, lid: isEye(p.role) ? layer(x, y, cw, ch, clip, p.lid ?? DEFAULT_LID) : undefined })
  }
  return { base: baseLayer(rig, src, w, h, fillImage) ?? layer(0, 0, w, h, outline ? [outline] : []), parts }
}

/**
 * Draws the character in image pixel space (0..w, 0..h); the caller sets the transform for zoom and position.
 * Order: base image within the mask, then every part by z: eyes squashed over their lid colour, the mouth's open area,
 * moved limbs as textures cut from the source. Sway turns everything about the bottom centre.
 * With `sprites` (from `rigSprites` at the same w*h) the textures are blitted instead of clipped from `src`.
 * `fillImage`: the AI fill image for `rig.fill` (editor preview; the sprites already contain it).
 */
export function drawRig(
  ctx: CanvasRenderingContext2D,
  rig: Rig,
  src: CanvasImageSource,
  w: number,
  h: number,
  pose: Pose,
  sprites?: RigSprites,
  fillImage?: CanvasImageSource | null,
) {
  const outline = maskOutline(rig)
  const path = (pts: Point[]) => trace(ctx, pts, w, h)
  const sway = rotateAbout(pose.sway, [w / 2, h])
  // With both lips defined the lips part and the face around them is warped instead of the Phase 4 mouth fill.
  const lips = mouthTextures(rig, src, w, h)
  const motion = lips && (pose.mouth > 0.002 || Math.abs(pose.wide) > 0.002) ? mouthMotion(lips.geo, pose.mouth, pose.wide) : null
  ctx.save()
  ctx.transform(...sway)
  if (motion && lips?.face) {
    // The warped face mesh replaces the base there; its outline never moves, so the two fit. The base is cut out
    // 2 device px smaller, so its anti-aliased edge lies under the mesh and no hairline shows.
    const t = ctx.getTransform()
    ctx.beginPath()
    ctx.rect(0, 0, w, h)
    for (const p of faceOutline(lips.geo, 2 / (Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) || 1))) ctx.lineTo(...p)
    ctx.closePath()
    ctx.clip('evenodd')
  }
  const filled = sprites ? null : baseLayer(rig, src, w, h, fillImage)
  if (sprites) ctx.drawImage(sprites.base, 0, 0, w, h)
  else if (filled) ctx.drawImage(filled, 0, 0, w, h)
  else {
    if (outline) {
      path(outline)
      ctx.clip()
    }
    ctx.drawImage(src, 0, 0, w, h)
  }
  ctx.restore()
  if (motion && lips) {
    ctx.save()
    ctx.transform(...sway)
    drawLips(ctx, lips, motion, rig.mouth?.color ?? DEFAULT_MOUTH)
    ctx.restore()
  }
  // With a fill the base no longer shows the moving parts, so they are drawn even at rest.
  const always = (rig.fill?.mode ?? 'none') !== 'none' ? movingParts(rig.parts) : null
  for (const p of [...rig.parts].sort((a, b) => a.z - b.z)) {
    const m = partMatrix(rig.parts, p, pose, w, h)
    const eye = isEye(p.role) && pose.blink > 0
    const mouth = p.role === 'mouth' && !lips ? mouthOpenPolygon(rig, pose.mouth, pose.wide) : null
    if (!eye && !mouth && isIdentity(m) && !always?.has(p.id)) continue // unmoved: the base image already shows it
    const sp = sprites?.parts.get(p.id)
    const texture = () => (sp ? ctx.drawImage(sp.img, sp.x, sp.y) : ctx.drawImage(src, 0, 0, w, h))
    ctx.save()
    ctx.transform(...sway)
    ctx.transform(...m)
    // The texture of a part is its polygon within the mask, so moved parts carry no background along.
    if (!sp) {
      if (outline) {
        path(outline)
        ctx.clip()
      }
      path(p.polygon)
      ctx.clip()
    }
    if (eye) {
      if (sp?.lid) ctx.drawImage(sp.lid, sp.x, sp.y)
      else {
        ctx.fillStyle = p.lid ?? DEFAULT_LID
        ctx.fill()
      }
      ctx.transform(...blinkMatrix(p.pivot[1] * h, pose.blink))
    }
    if (!mouth) texture()
    else {
      if (!isIdentity(m)) texture()
      if (sp) {
        path(p.polygon)
        ctx.clip()
      }
      path(mouth)
      ctx.fillStyle = rig.mouth?.color ?? DEFAULT_MOUTH
      ctx.fill()
    }
    ctx.restore()
  }
}

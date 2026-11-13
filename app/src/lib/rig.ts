// Avatar character rig (mirror of src-tauri/src/rig.rs, format version 1) and pure helpers.
// Coordinates are normalised to the image: [0, 0] top left, [1, 1] bottom right.

export const RIG_VERSION = 1
export const MAX_PARTS = 64
export const MAX_POLYGON_POINTS = 1024
export type Point = [number, number]
export type RigKind = 'portrait' | 'fullbody'
export type PartRole =
  | 'eyeL' | 'eyeR' | 'mouth' | 'armL' | 'armR' | 'handL' | 'handR' | 'legL' | 'legR' | 'head' | 'body' | 'custom'

export interface RigPart {
  id: string
  role: PartRole
  polygon: Point[]
  pivot: Point
  z: number
  parent?: string
  /** Display name in the part editor; the role name when absent. */
  label?: string
  /** Eyelid colour of an eye part (`#rrggbb`), drawn while blinking. */
  lid?: string
}

export interface RigMouth {
  states: { id: string; polygon: Point[] }[]
  /** Open-mouth shape inside the mouth part, scaled vertically with the loudness. */
  interior?: Point[]
  /** Fill of the open mouth (`#rrggbb`). */
  color?: string
  /** Upper and lower lip (both or neither): with them the lips part and the face around the mouth is warped. */
  lipUpper?: Point[]
  lipLower?: Point[]
  /** Left and right mouth corner (image left first); derived from the lips when absent. */
  corners?: [Point, Point]
  /** Face warp strength 0..1 (how far cheeks and chin follow the lips); DEFAULT_WARP when absent. */
  warp?: number
}
export const DEFAULT_WARP = 0.6

export interface Rig {
  version: number
  id: string
  name: string
  /** Derived from the parts on save: full body iff arm or leg parts exist. */
  kind: RigKind
  image: { file: string; width: number; height: number }
  /** `points`: outline as drawn; `smoothed`: baked Smooth/Snap result (`smooth`, `snap`: 0..1), used for rendering. */
  mask: { points: Point[]; smoothed?: Point[]; smooth?: number; snap?: number }
  parts: RigPart[]
  mouth?: RigMouth
  /** Epoch ms. */
  createdAt: number
  updatedAt: number
}

const LIMBS: PartRole[] = ['armL', 'armR', 'legL', 'legR']
export const deriveKind = (parts: { role: PartRole }[]): RigKind => (parts.some((p) => LIMBS.includes(p.role)) ? 'fullbody' : 'portrait')

/** Image pixel position -> normalised point, clamped into the image. */
export function normalizePoint(x: number, y: number, width: number, height: number): Point {
  const c = (v: number) => (Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)))
  return [c(x / width), c(y / height)]
}

export const validId = (id: string) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)
export const validColor = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c)
const validName = (s: string) => {
  const n = s.trim()
  return !!n && [...n].length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/.test(n)
}

/** Every point is a finite pair inside the image (0..1). */
export const inImage = (pts: Point[]) => pts.every((p) => p.length === 2 && p.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
const polygonOk = (pts: Point[], max: number) => pts.length >= 3 && pts.length <= max && inImage(pts)

/** Whether giving `child` the parent `parent` would create a loop (or hang it on a chain that already loops). */
export function wouldLoop(parts: { id: string; parent?: string }[], child: string, parent: string): boolean {
  const byId = new Map(parts.map((p) => [p.id, p.parent]))
  let cur: string | undefined = parent
  for (let steps = 0; cur !== undefined && steps <= parts.length; steps++) {
    if (cur === child) return true
    cur = byId.get(cur)
  }
  return cur !== undefined
}

/** Same rules as `rig::validate` in Rust (which has the final say); returns the first problem or null. */
export function validateRig(r: Rig): string | null {
  if (r.version !== RIG_VERSION) return `Unsupported format version ${r.version}`
  if (!validId(r.id)) return 'Invalid character id'
  if (!validName(r.name)) return 'Invalid name'
  if (!['image.png', 'image.jpg', 'image.webp'].includes(r.image.file)) return 'Invalid image file name'
  const side = (v: number) => Number.isInteger(v) && v >= 1 && v <= 8192
  if (!side(r.image.width) || !side(r.image.height)) return 'Invalid image size'
  if (r.mask.points.length && !polygonOk(r.mask.points, 4096)) return 'Invalid mask'
  if (r.mask.smoothed && (r.mask.smoothed.length > 4096 || !inImage(r.mask.smoothed))) return 'Invalid smoothed mask'
  if (!inImage([[r.mask.smooth ?? 0, r.mask.snap ?? 0]])) return 'Invalid mask smoothing'
  if (r.parts.length > MAX_PARTS) return 'Too many parts'
  const ids = new Set<string>()
  const roles = new Set<PartRole>()
  for (const p of r.parts) {
    if (!validId(p.id) || ids.has(p.id)) return `Invalid or duplicate part id '${p.id}'`
    ids.add(p.id)
    if (!polygonOk(p.polygon, MAX_POLYGON_POINTS) || !inImage([p.pivot])) return `Part '${p.id}': invalid polygon or pivot`
    if (!Number.isInteger(p.z) || Math.abs(p.z) > 1000) return `Part '${p.id}': invalid z`
    if (p.role !== 'custom' && roles.has(p.role)) return `Part '${p.id}': only one part per role (except custom)`
    roles.add(p.role)
    if (p.label !== undefined && !validName(p.label)) return `Part '${p.id}': invalid label`
    if (p.lid !== undefined && !validColor(p.lid)) return `Part '${p.id}': eyelid colour must be #rrggbb`
  }
  const byId = new Map(r.parts.map((p) => [p.id, p]))
  for (const p of r.parts) {
    let cur = p.parent
    for (let steps = 0; cur !== undefined; steps++) {
      const next = byId.get(cur)
      if (!next) return `Part '${p.id}': unknown parent '${cur}'`
      if (steps >= r.parts.length) return `Part '${p.id}': parent chain loops`
      cur = next.parent
    }
  }
  const states = r.mouth?.states ?? []
  if (states.length > 8) return 'Too many mouth states'
  if (new Set(states.map((s) => s.id)).size !== states.length || states.some((s) => !validId(s.id) || !polygonOk(s.polygon, MAX_POLYGON_POINTS)))
    return 'Invalid mouth state'
  if (r.mouth?.interior && !polygonOk(r.mouth.interior, MAX_POLYGON_POINTS)) return 'Invalid open mouth shape'
  if (r.mouth?.color !== undefined && !validColor(r.mouth.color)) return 'Mouth colour must be #rrggbb'
  const { lipUpper, lipLower, corners, warp } = r.mouth ?? {}
  if (!lipUpper !== !lipLower) return 'Define both lips or neither'
  if ((lipUpper && !polygonOk(lipUpper, MAX_POLYGON_POINTS)) || (lipLower && !polygonOk(lipLower, MAX_POLYGON_POINTS))) return 'Invalid lip shape'
  if (corners && (corners.length !== 2 || !inImage(corners))) return 'Invalid mouth corners'
  if (warp !== undefined && !inImage([[warp, 0]])) return 'Face warp must be from 0 to 1'
  return null
}

/** Mask outline to render: the baked smoothed one if present, else the drawn one; null without a usable mask. */
export function maskOutline(r: Rig): Point[] | null {
  const m = r.mask.smoothed && r.mask.smoothed.length >= 3 ? r.mask.smoothed : r.mask.points
  return m.length >= 3 ? m : null
}

// Smart select (Phase 7): prompt handling for the MobileSAM decoder (src-tauri/src/sam.rs). Pure, tested in
// tests/smartSelect.test.ts. Prompts are kept normalised to the image (0..1) like every other editor coordinate.
import { simplifyTo, traceLargest } from './maskGeometry.ts'
import type { Point } from './rig.ts'

/** Long side of the image the encoder gets (sam::LONG_SIDE). */
export const ENCODE_SIDE = 1024

export type Prompt = { kind: 'point'; p: Point; positive: boolean } | { kind: 'box'; a: Point; b: Point }

/** Size of the encoder input for a w*h image: long side 1024, aspect kept (small images are scaled up, as in SAM). */
export function encodeSize(w: number, h: number): [number, number] {
  const s = ENCODE_SIDE / Math.max(w, h, 1)
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]
}

/**
 * Decoder input for the prompts on an encW*encH encoder image: points in its pixels with SAM labels (1 figure,
 * 0 background, 2/3 the corners of the last box). Without a box SAM wants one padding point (label -1). Null when
 * there is nothing to select: background points alone do not describe an object.
 */
export function samPrompt(prompts: Prompt[], encW: number, encH: number): { points: Point[]; labels: number[] } | null {
  const px = ([x, y]: Point): Point => [x * encW, y * encH]
  const pts = prompts.filter((p) => p.kind === 'point')
  const box = prompts.findLast((p) => p.kind === 'box')
  if (!box && !pts.some((p) => p.positive)) return null
  const points = pts.map((p) => px(p.p))
  const labels = pts.map((p): number => (p.positive ? 1 : 0))
  if (box) {
    points.push(px([Math.min(box.a[0], box.b[0]), Math.min(box.a[1], box.b[1])]), px([Math.max(box.a[0], box.b[0]), Math.max(box.a[1], box.b[1])]))
    labels.push(2, 3)
  } else {
    points.push([0, 0])
    labels.push(-1)
  }
  return { points, labels }
}

/** Combines a proposal with the current mask bitmap: added, or removed with Erase. Same length, 0/1 bytes. */
export const mergeMask = (mask: Uint8Array, proposal: Uint8Array, erase: boolean) =>
  mask.map((m, i) => (erase ? m & (proposal[i] ^ 1) : m | proposal[i]))

/**
 * Outline (normalised 0..1) of the largest area of a w*h proposal, simplified like the mask tools and with at most
 * `max` points; null when the proposal is empty or too small to outline.
 */
export function maskToPolygon(mask: Uint8Array, w: number, h: number, max: number): Point[] | null {
  const t = traceLargest(mask, w, h)
  const p = t.length >= 3 ? simplifyTo(t, 0.7, max) : []
  return p.length >= 3 ? p.map(([x, y]): Point => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]) : null
}

// "Detect face": MediaPipe Face Mesh landmarks (478 points, from src-tauri/src/face.rs) -> eye and mouth outlines,
// both lips and the mouth corners for the part editor. Pure, tested in tests/faceParts.test.ts.
import { polygonArea } from './maskGeometry.ts'
import type { Point } from './rig.ts'

export const FACE_LANDMARKS = 478
// MediaPipe indices. The person's right eye is on the left of a frontal picture; roles use the character's own sides.
const EYE_R = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7]
const EYE_L = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249]
// Outer lip contour, upper arc corner to corner (61 -> 291), then the lower arc back (291 -> 61).
const OUTER_UP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]
const OUTER_LOW = [291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61]
// Inner lip contours, both from the inner corner 78 to 308, pointwise opposite each other.
const INNER_UP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
const INNER_LOW = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]

export interface FaceParts {
  eyeL: Point[]
  eyeR: Point[]
  mouth: Point[]
  lipUpper: Point[]
  lipLower: Point[]
  /** Image left first. */
  corners: [Point, Point]
}

/**
 * Outlines from the landmarks (normalised, clamped into the image). The lips part along the middle between the inner
 * lip contours, so an open mouth in the picture is split between both lips and the two lips cover the whole mouth,
 * as Auto-split does. Null for a wrong landmark count, non-finite values or an eye or lip too small to edit.
 */
export function faceParts(lm: Point[]): FaceParts | null {
  if (lm.length !== FACE_LANDMARKS || !lm.every((p) => p.length === 2 && p.every(Number.isFinite))) return null
  const c = (v: number) => Math.min(1, Math.max(0, v))
  const at = (i: number): Point => [c(lm[i][0]), c(lm[i][1])]
  const mid = INNER_UP.map((u, k): Point => {
    const [a, b] = [at(u), at(INNER_LOW[k])]
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  })
  const f: FaceParts = {
    eyeR: EYE_R.map(at),
    eyeL: EYE_L.map(at),
    mouth: [...OUTER_UP, ...OUTER_LOW.slice(1, -1)].map(at),
    lipUpper: [...OUTER_UP.map(at), ...mid.toReversed()],
    lipLower: [...OUTER_LOW.map(at), ...mid],
    corners: [at(61), at(291)].sort((a, b) => a[0] - b[0]) as [Point, Point],
  }
  // About a 4 px square in a 1000 px image: anything smaller is a failed detection or a face too small to animate.
  const tiny = 1.6e-5
  return [f.eyeL, f.eyeR, f.lipUpper, f.lipLower].some((p) => Math.abs(polygonArea(p)) < tiny) ? null : f
}

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faceParts, FACE_LANDMARKS } from '../src/lib/faceParts.ts'
import { polygonArea } from '../src/lib/maskGeometry.ts'
import { mouthGeometry } from '../src/lib/mouthWarp.ts'
import { validateRig, type Point, type Rig } from '../src/lib/rig.ts'
import { bbox, defaultPivot } from '../src/lib/rigRender.ts'

// A frontal face in MediaPipe numbering: eyes as rings, lips as half ellipses, the mouth slightly open.
const ring = (ids: number[], cx: number, cy: number, rx: number, ry: number, out: Point[], from = 0, to = Math.PI * 2) =>
  ids.forEach((i, k) => {
    const a = from + ((to - from) * k) / (ids.length - (to - from < 6 ? 1 : 0))
    out[i] = [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]
  })
function face(s = 1): Point[] {
  const lm: Point[] = Array.from({ length: FACE_LANDMARKS }, () => [0.5, 0.5])
  ring([33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7], 0.4, 0.4, 0.04 * s, 0.015 * s, lm)
  ring([263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249], 0.6, 0.4, 0.04 * s, 0.015 * s, lm)
  // Upper outer arc from the image-left corner over the top (angles pi -> 2 pi), lower arc back underneath.
  ring([61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291], 0.5, 0.6, 0.08 * s, 0.03 * s, lm, Math.PI, Math.PI * 2)
  ring([291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61], 0.5, 0.6, 0.08 * s, 0.03 * s, lm, 0, Math.PI)
  ring([78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308], 0.5, 0.6, 0.06 * s, 0.006 * s, lm, Math.PI, Math.PI * 2)
  ring([78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308], 0.5, 0.6, 0.06 * s, 0.006 * s, lm, Math.PI, 0)
  return lm
}

test('landmarks become eyes, mouth, lips and corners on the right sides', () => {
  const f = faceParts(face())!
  assert.ok(f)
  // The person's right eye is on the image left.
  assert.ok(bbox(f.eyeR).x1 < 0.5 && bbox(f.eyeL).x0 > 0.5)
  assert.equal(f.eyeL.length, 16)
  assert.equal(f.mouth.length, 20, 'the outer lip contour, corners once')
  assert.deepEqual(f.corners.map((p) => p.map((v) => +v.toFixed(6))), [[0.42, 0.6], [0.58, 0.6]], 'image left first')
  // Upper lip above the parting line, lower below; both share it and together cover the mouth.
  assert.ok(f.lipUpper.every(([, y]) => y <= 0.6 + 1e-9) && f.lipLower.every(([, y]) => y >= 0.6 - 1e-9))
  const sum = Math.abs(polygonArea(f.lipUpper)) + Math.abs(polygonArea(f.lipLower))
  assert.ok(Math.abs(sum - Math.abs(polygonArea(f.mouth))) < 1e-4 + Math.abs(polygonArea(f.mouth)) * 0.3)
  assert.deepEqual(f.lipUpper.slice(-11).toReversed(), f.lipLower.slice(-11), 'the same midline')
  // Default pivots sit in the middle of eyes and mouth.
  const [px, py] = defaultPivot('mouth', f.mouth)
  assert.ok(Math.abs(px - 0.5) < 1e-9 && Math.abs(py - 0.6) < 0.01)
  // The renderer can move these lips (in pixels of a 1000 px image).
  const px1000 = (p: Point[]) => p.map(([x, y]): Point => [x * 1000, y * 1000])
  assert.ok(mouthGeometry(px1000(f.lipUpper), px1000(f.lipLower), px1000(f.corners) as [Point, Point], 0.6))
})

test('the parts make a valid rig', () => {
  const f = faceParts(face())!
  const part = (id: string, role: 'eyeL' | 'eyeR' | 'mouth', polygon: Point[], z: number) => ({ id, role, polygon, pivot: defaultPivot(role, polygon), z })
  const rig: Rig = {
    version: 1,
    id: 'face-test',
    name: 'Face test',
    kind: 'portrait',
    image: { file: 'image.png', width: 1000, height: 1000 },
    mask: { points: [] },
    parts: [part('eye-r', 'eyeR', f.eyeR, 0), part('eye-l', 'eyeL', f.eyeL, 1), part('mouth', 'mouth', f.mouth, 2)],
    mouth: { states: [], lipUpper: f.lipUpper, lipLower: f.lipLower, corners: f.corners },
    createdAt: 0,
    updatedAt: 0,
  }
  assert.equal(validateRig(rig), null)
})

test('bad or tiny landmarks give nothing; points are clamped into the image', () => {
  assert.equal(faceParts(face().slice(1)), null, 'wrong count')
  const nan = face()
  nan[5] = [Number.NaN, 0.5]
  assert.equal(faceParts(nan), null)
  assert.equal(faceParts(face(0.02)), null, 'a face of a few pixels')
  const off = face().map(([x, y]): Point => [x - 0.38, y])
  const f = faceParts(off)!
  assert.ok(f && f.eyeR.every(([x]) => x >= 0), 'clamped at the left edge')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Point, RigPart } from '../src/lib/rig.ts'
import {
  REST,
  apply,
  blinkMatrix,
  defaultPivot,
  isIdentity,
  mouthOpenPolygon,
  mul,
  partMatrix,
  rigMouthGeo,
  rotateAbout,
  sampleRing,
  scaleAbout,
} from '../src/lib/rigRender.ts'

const near = (a: Point, b: Point, msg?: string) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9, `${a} != ${b} ${msg ?? ''}`)
const box = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const part = (id: string, role: RigPart['role'], polygon: Point[], pivot: Point, parent?: string): RigPart => ({ id, role, polygon, pivot, z: 0, parent })

test('default pivots per role', () => {
  const arm = box(0.6, 0.3, 0.7, 0.6)
  near(defaultPivot('armL', arm), [0.65, 0.3 + 0.3 * 0.08])
  near(defaultPivot('legR', box(0.4, 0.6, 0.5, 1)), [0.45, 0.6 + 0.4 * 0.08])
  near(defaultPivot('handR', box(0.6, 0.6, 0.7, 0.7)), [0.65, 0.608])
  near(defaultPivot('eyeL', box(0.3, 0.2, 0.4, 0.25)), [0.35, 0.225])
  near(defaultPivot('mouth', box(0.4, 0.4, 0.6, 0.5)), [0.5, 0.45])
  near(defaultPivot('custom', []), [0.5, 0.5])
})

test('matrix maths', () => {
  near(apply(rotateAbout(90, [1, 1]), [2, 1]), [1, 2]) // clockwise on screen (y down)
  near(apply(scaleAbout(2, 0.5, [1, 1]), [3, 3]), [5, 2])
  const m = mul(rotateAbout(90, [0, 0]), scaleAbout(2, 1, [0, 0]))
  near(apply(m, [1, 0]), [0, 2]) // scale first, then rotate
  assert.ok(isIdentity(rotateAbout(0, [5, 5])))
  assert.ok(!isIdentity(rotateAbout(1, [5, 5])))
})

test('a hand follows its arm', () => {
  const arm = part('arm-l', 'armL', box(50, 0, 60, 50), [55, 0])
  const hand = part('hand-l', 'handL', box(50, 50, 60, 60), [55, 50], 'arm-l')
  const parts = [arm, hand]
  const pose = { ...REST, armL: 90 }
  // Image 1x1 so pixel and normalised coordinates agree.
  const ma = partMatrix(parts, arm, pose, 1, 1)
  const mh = partMatrix(parts, hand, pose, 1, 1)
  near(apply(ma, [55, 50]), [5, 0]) // the elbow end swings to the left of the shoulder
  near(apply(mh, [55, 50]), [5, 0]) // the wrist goes with it
  near(apply(mh, [55, 60]), [-5, 0])
  assert.ok(isIdentity(partMatrix(parts, hand, REST, 1, 1)))
  // Without a parent the hand stays put.
  assert.ok(isIdentity(partMatrix([arm, { ...hand, parent: undefined }], { ...hand, parent: undefined }, pose, 1, 1)))
  // A (corrupt) parent loop terminates.
  const a = part('a', 'armL', box(0, 0, 1, 1), [0, 0], 'b')
  const b = part('b', 'armR', box(0, 0, 1, 1), [0, 0], 'a')
  assert.ok(Number.isFinite(partMatrix([a, b], a, { ...REST, armL: 10, armR: 10 }, 1, 1)[0]))
})

test('blink squashes toward the centre line', () => {
  const m = blinkMatrix(10, 0.5)
  near(apply(m, [3, 10]), [3, 10])
  near(apply(m, [3, 14]), [3, 12])
  near(apply(m, [3, 6]), [3, 8])
  near(apply(blinkMatrix(10, 1), [3, 0]), [3, 10])
  assert.ok(isIdentity(blinkMatrix(10, 0)))
  near(apply(blinkMatrix(10, 2), [3, 0]), [3, 10]) // clamped
})

test('open mouth scales the interior vertically', () => {
  const mouth = part('mouth', 'mouth', box(0.4, 0.6, 0.6, 0.7), [0.5, 0.65])
  const interior = box(0.45, 0.62, 0.55, 0.68)
  assert.equal(mouthOpenPolygon({ parts: [mouth], mouth: { states: [], interior } }, 0), null)
  assert.equal(mouthOpenPolygon({ parts: [], mouth: { states: [], interior } }, 1), null)
  const full = mouthOpenPolygon({ parts: [mouth], mouth: { states: [], interior } }, 1)!
  full.forEach((p, i) => near(p, interior[i]))
  const half = mouthOpenPolygon({ parts: [mouth], mouth: { states: [], interior } }, 0.5)!
  near(half[0], [0.45, 0.635])
  near(half[2], [0.55, 0.665])
  // Fallback without an open shape: shrunk mouth polygon.
  const fb = mouthOpenPolygon({ parts: [mouth] }, 1)!
  near(fb[0], [0.42, 0.615])
  near(fb[2], [0.58, 0.685])
})

test('eyelid colour is sampled around the eye', () => {
  const w = 40
  const h = 40
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inEye = x >= 15 && x < 25 && y >= 17 && y < 23
      rgba.set(inEye ? [20, 20, 20, 255] : [200, 160, 120, 255], (y * w + x) * 4)
    }
  assert.equal(sampleRing(rgba, w, h, box(15, 17, 25, 23)), '#c8a078')
  assert.equal(sampleRing(rgba, w, h, [[1, 1]]), null)
  assert.equal(sampleRing(rgba, w, h, box(500, 500, 600, 600)), null)
})

test('viseme shape widens or narrows the Phase 4 mouth; lips switch to the lip geometry', () => {
  const mouth = part('m', 'mouth', box(0.4, 0.6, 0.6, 0.7), [0.5, 0.65])
  const rig = { parts: [mouth], mouth: { states: [] } }
  const width = (pts: Point[] | null) => Math.max(...pts!.map((p) => p[0])) - Math.min(...pts!.map((p) => p[0]))
  assert.deepEqual(mouthOpenPolygon(rig, 1, 0), mouthOpenPolygon(rig, 1))
  assert.ok(width(mouthOpenPolygon(rig, 1, 1)) > width(mouthOpenPolygon(rig, 1, 0)))
  assert.ok(width(mouthOpenPolygon(rig, 1, -1)) < width(mouthOpenPolygon(rig, 1, 0)))
  assert.equal(rigMouthGeo(rig, 100, 100), null, 'no lips')
  const lips = { states: [], lipUpper: box(0.4, 0.6, 0.6, 0.65), lipLower: box(0.4, 0.65, 0.6, 0.7) }
  assert.equal(rigMouthGeo({ parts: [], mouth: lips }, 100, 100), null, 'no mouth part')
  const g = rigMouthGeo({ parts: [mouth], mouth: lips }, 200, 100)!
  assert.ok(Math.abs(g.half - 20) < 1e-9 && Math.abs(g.c[0] - 100) < 1e-9)
  assert.ok(rigMouthGeo({ parts: [mouth], mouth: { ...lips, warp: 1 } }, 200, 100)!.radius > g.radius, 'default warp is below the maximum')
})
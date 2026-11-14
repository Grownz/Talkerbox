import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Point, Rig, RigPart } from '../src/lib/rig.ts'
import {
  REST,
  apply,
  blinkMatrix,
  defaultPivot,
  drawRig,
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

test('blink: the upper lid travels 2/3 of the eye height, the lower lid 1/3', () => {
  // Eye from y 10 (upper lid) to 40 (lower lid): height 30.
  const half = blinkMatrix(10, 40, 0.5)
  near(apply(half, [3, 10]), [3, 20]) // upper lid down by 0.5 * 2/3 * 30
  near(apply(half, [3, 40]), [3, 35]) // lower lid up by 0.5 * 1/3 * 30
  const shut = blinkMatrix(10, 40, 1)
  near(apply(shut, [3, 10]), [3, 30]) // both meet 2/3 of the way down,
  near(apply(shut, [3, 40]), [3, 30]) // 1/3 above the lower lid
  assert.ok(isIdentity(blinkMatrix(10, 40, 0)))
  near(apply(blinkMatrix(10, 40, 2), [3, 10]), [3, 30]) // clamped
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
test('the base cut for the face warp is the image minus the face outline, nothing joined to the corner', () => {
  // Recording 2D context; just enough canvas for drawRig to cut its textures.
  const calls: [string, unknown[]][] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_, k: string) =>
      k === 'getTransform' ? () => ({ a: 1, b: 0, c: 0, d: 1 }) : k === 'canvas' ? {} : (...a: unknown[]) => void calls.push([k, a]),
    set: () => true,
  })
  const doc = (globalThis as { document?: unknown }).document
  ;(globalThis as { document?: unknown }).document = { createElement: () => ({ getContext: () => ctx, width: 1, height: 1 }) }
  try {
    const [W, H] = [1500, 2500]
    const n = (x: number, y: number): Point => [x / W, y / H]
    const rig = {
      parts: [part('m', 'mouth', [n(730, 330), n(770, 330), n(750, 340)], n(750, 330))],
      mask: { points: [n(10, 10), n(1490, 10), n(1490, 2490)] },
      mouth: { states: [], lipUpper: [n(730, 330), n(750, 324), n(770, 330)], lipLower: [n(770, 330), n(750, 338), n(730, 330)], warp: 1 },
    } as unknown as Rig
    drawRig(ctx as unknown as CanvasRenderingContext2D, rig, {} as CanvasImageSource, W, H, { ...REST, wide: 0.4 })
    // Replay the path up to the first even-odd clip with the canvas rules: rect() closes its subpath and starts a new
    // one at its corner, lineTo() continues the current subpath.
    const end = calls.findIndex(([k, a]) => k === 'clip' && a[0] === 'evenodd')
    const start = calls.slice(0, end).findLastIndex(([k]) => k === 'beginPath')
    const subs: Point[][] = []
    for (const [k, a] of calls.slice(start + 1, end) as [string, number[]][]) {
      if (k === 'rect') subs.push(box(a[0], a[1], a[0] + a[2], a[1] + a[3]), [[a[0], a[1]]])
      else if (k === 'moveTo') subs.push([[a[0], a[1]]])
      else if (k === 'lineTo') (subs.at(-1) ?? subs[subs.push([]) - 1]).push([a[0], a[1]])
    }
    const used = subs.filter((s) => s.length > 1)
    assert.equal(used.length, 2, 'image rectangle and face outline')
    assert.deepEqual(used[0], box(0, 0, W, H))
    assert.equal(used[1].length, 4)
    assert.ok(used[1].every(([x, y]) => Math.hypot(x - 750, y - 330) < 300), `face outline ${used[1]} reaches the corner`)
  } finally {
    ;(globalThis as { document?: unknown }).document = doc
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chaikin,
  douglasPeucker,
  floodSelect,
  isClockwise,
  perimeter,
  pointInPolygon,
  polygonArea,
  resample,
  simplifyTo,
  smoothPolygon,
  snapToGradient,
  traceLargest,
} from '../src/lib/maskGeometry.ts'
import type { Point } from '../src/lib/rig.ts'

const square: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]]
const circle = (cx: number, cy: number, r: number, n: number): Point[] =>
  Array.from({ length: n }, (_, i): Point => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)])

test('area, orientation, perimeter', () => {
  assert.equal(polygonArea(square), 100)
  assert.ok(isClockwise(square))
  assert.equal(polygonArea([...square].reverse()), -100)
  assert.equal(polygonArea([[0, 0], [5, 5], [10, 10]]), 0) // collinear
  assert.equal(polygonArea([[1, 1]]), 0)
  assert.equal(polygonArea([]), 0)
  assert.equal(perimeter(square), 40)
})

test('point in polygon', () => {
  assert.ok(pointInPolygon([5, 5], square))
  assert.ok(!pointInPolygon([15, 5], square))
  assert.ok(!pointInPolygon([5, 5], [[0, 0], [1, 1]]))
  // Concave "U": the notch is outside.
  const u: Point[] = [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]]
  assert.ok(pointInPolygon([0.5, 2], u))
  assert.ok(!pointInPolygon([1.5, 2], u))
})

test('chaikin doubles points, keeps the shape inside the hull and respects the limit', () => {
  const c = chaikin(square, 2)
  assert.equal(c.length, 16)
  assert.ok(c.every(([x, y]) => x >= 0 && x <= 10 && y >= 0 && y <= 10))
  assert.ok(Math.abs(polygonArea(c)) < 100 && Math.abs(polygonArea(c)) > 80)
  assert.equal(chaikin(square, 10, 40).length, 32)
  assert.deepEqual(chaikin([[0, 0], [1, 1]], 3), [[0, 0], [1, 1]])
  assert.equal(chaikin(square, 0).length, 4)
})

test('douglas-peucker removes near-collinear points and handles degenerate input', () => {
  const noisy: Point[] = [[0, 0], [5, 0.01], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]]
  assert.deepEqual(douglasPeucker(noisy, 0.1), square)
  assert.equal(douglasPeucker(noisy, 0).length, 5) // exact collinear points go, the bump stays
  assert.deepEqual(douglasPeucker([[0, 0], [1, 0], [2, 0], [3, 0]], 0.1), [[0, 0], [3, 0]])
  assert.deepEqual(douglasPeucker([[1, 1], [1, 1], [1, 1], [1, 1]], 0.1), [[1, 1]])
  assert.equal(douglasPeucker([[0, 0], [1, 1]], 1).length, 2)
})

test('simplify and smooth clamp to the point limit', () => {
  const big = circle(0, 0, 100, 5000)
  assert.ok(simplifyTo(big, 0, 4096).length <= 4096)
  assert.ok(simplifyTo(big, 0, 50).length <= 50)
  assert.ok(smoothPolygon(big, 1).length <= 4096)
  const s = smoothPolygon(square, 1)
  assert.ok(s.length > 4 && s.length <= 4096)
  assert.equal(smoothPolygon(square, 0).length, 4)
  assert.equal(smoothPolygon([[0, 0], [1, 1]], 1).length, 2)
})

test('resample spaces points evenly by arc length', () => {
  const r = resample(square, 8)
  assert.deepEqual(r, [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]])
  assert.equal(resample(circle(0, 0, 10, 7), 100).length, 100)
  assert.deepEqual(resample([[1, 1]], 5), [[1, 1]])
})

test('contour tracing finds the outer outline of the largest region', () => {
  const w = 12
  const h = 10
  const m = new Uint8Array(w * h)
  const fill = (x0: number, y0: number, x1: number, y1: number, v = 1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = v
  }
  fill(2, 2, 8, 7) // big rectangle
  fill(4, 4, 5, 5, 0) // hole: ignored
  fill(10, 0, 11, 1) // small separate blob: ignored
  const t = traceLargest(m, w, h)
  assert.deepEqual(douglasPeucker(t, 0.1), [[2.5, 2.5], [8.5, 2.5], [8.5, 7.5], [2.5, 7.5]])
  assert.ok(isClockwise(t))
  assert.equal(new Set(t.map((p) => p.join())).size, t.length) // each boundary pixel once
  assert.deepEqual(traceLargest(new Uint8Array(4), 2, 2), [])
  const one = new Uint8Array(9)
  one[4] = 1
  assert.deepEqual(traceLargest(one, 3, 3), [[1.5, 1.5]])
})

test('contour tracing passes through a pinch point (self-touching region)', () => {
  // Two 3x3 squares touching at one corner pixel (8-connected): one region.
  const w = 7
  const m = new Uint8Array(w * w)
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) m[y * w + x] = m[(y + 3) * w + x + 3] = 1
  const t = traceLargest(m, w, w)
  const pts = new Set(t.map((p) => p.join()))
  assert.ok(pts.has('0.5,0.5') && pts.has('5.5,5.5'))
  assert.equal(pts.size, 16) // all boundary pixels of both squares (the centres are interior)
  assert.ok(t.length <= 20)
})

test('magic wand flood fill stays within tolerance and is 4-connected', () => {
  const w = 4
  const px = [0, 0, 10, 200, 0, 0, 10, 200, 200, 200, 200, 200, 5, 200, 0, 0]
  const rgba = px.flatMap((v) => [v, v, v, 255])
  const sel = floodSelect(rgba, w, 4, 0, 0, 0.05)
  assert.deepEqual([...sel], [1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(floodSelect(rgba, w, 4, 9, 9, 1).reduce((a, b) => a + b, 0), 0)
})

test('edge snap pulls a slightly too large circle onto a white disc', () => {
  const w = 100
  const disc = (x: number, y: number) => (Math.hypot(x + 0.5 - 50, y + 0.5 - 50) <= 30 ? 1 : 0)
  const snapped = snapToGradient(circle(50, 50, 35, 48), disc, w, w, 8)
  const radii = snapped.map(([x, y]) => Math.hypot(x - 50, y - 50))
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length
  assert.ok(Math.abs(mean - 30) < 1, `mean radius ${mean}`)
  assert.ok(radii.every((r) => Math.abs(r - 30) < 1.5), `radius range ${Math.min(...radii)}-${Math.max(...radii)}`)
  // Same from the inside.
  const inner = snapToGradient(circle(50, 50, 25, 48), disc, w, w, 8).map(([x, y]) => Math.hypot(x - 50, y - 50))
  assert.ok(inner.every((r) => Math.abs(r - 30) < 1.5))
  // Out of reach: points stay put (no gradient within the radius).
  const far = snapToGradient(circle(50, 50, 45, 48), disc, w, w, 3).map(([x, y]) => Math.hypot(x - 50, y - 50))
  assert.ok(far.every((r) => Math.abs(r - 45) < 0.5))
})

test('edge snap is deterministic, stays in bounds and handles degenerate input', () => {
  const ramp = (x: number) => (x > 98 ? 1 : 0) // edge right at the border
  const rect: Point[] = [[1, 1], [99, 1], [99, 99], [1, 99]]
  const a = snapToGradient(rect, ramp, 100, 100, 10)
  assert.deepEqual(a, snapToGradient(rect, ramp, 100, 100, 10))
  assert.ok(a.every(([x, y]) => x >= 0 && x <= 100 && y >= 0 && y <= 100))
  assert.deepEqual(snapToGradient([[1, 1], [2, 2]], ramp, 100, 100, 5), [[1, 1], [2, 2]])
  assert.deepEqual(snapToGradient([[1, 1], [1, 1], [1, 1]], ramp, 100, 100, 5), [[1, 1], [1, 1], [1, 1]])
  assert.deepEqual(snapToGradient(square, ramp, 100, 100, 0), square)
})

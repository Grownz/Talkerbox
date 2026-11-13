import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  autoSplit,
  displace,
  faceMesh,
  faceOutline,
  gapPolygon,
  grow,
  lipMesh,
  mouthGeometry,
  mouthMotion,
  triAffine,
  triArea,
  type MouthGeo,
} from '../src/lib/mouthWarp.ts'
import type { Point } from '../src/lib/rig.ts'

/** Mouth outline: an ellipse around (cx, cy), rx x ry px, optionally turned by `deg`. */
const mouth = (cx = 200, cy = 300, rx = 40, ry = 12, deg = 0): Point[] => {
  const r = (deg * Math.PI) / 180
  return Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * 2 * Math.PI
    const x = Math.cos(a) * rx
    const y = Math.sin(a) * ry
    return [cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)]
  })
}
const geo = (warp = 0.6, poly = mouth(), corners?: [Point, Point]): MouthGeo => {
  const s = autoSplit(poly)!
  return mouthGeometry(s.upper, s.lower, corners ?? s.corners, warp)!
}
const area = (pts: Point[]) => Math.abs(pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2)
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

test('auto-split cuts the mouth along the corner line', () => {
  const s = autoSplit(mouth())!
  assert.deepEqual(s.corners, [[160, 300], [240, 300]])
  assert.ok(s.upper.every((p) => p[1] <= 300 + 1e-9) && s.lower.every((p) => p[1] >= 300 - 1e-9))
  assert.ok(s.upper.length >= 3 && s.lower.length >= 3)
  assert.equal(autoSplit([[0, 0], [0, 1], [0, 2]]), null, 'no width')
  assert.equal(autoSplit([[0, 0], [1, 1]]), null)
  // A triangle (one chain is just the corners) still gives two polygons.
  const t = autoSplit([[0, 0], [10, 0], [5, 5]])!
  assert.ok(t.upper.length >= 3 && t.lower.length >= 3)
})

test('geometry: frame, seam and warp radius', () => {
  const g = geo()
  assert.ok(near(g.half, 40) && near(g.u[0], 1) && near(g.v[1], 1))
  assert.ok(g.seam.every((y) => Math.abs(y) < 1e-9), 'auto-split lips meet on the corner line')
  assert.ok(near(g.top, -12, 0.1) && near(g.bottom, 12, 0.1))
  assert.ok(geo(1).radius > geo(0.6).radius && geo(0.6).radius > geo(0.1).radius)
  assert.equal(geo(0).radius, 0)
  assert.ok(geo(0.6).radius >= 1.5 * 80 * 0.95 && geo(0.6).radius <= 2 * 80, 'default ~1.5-2x the mouth width')
  assert.equal(mouthGeometry([[0, 0], [1, 0], [0.5, 0.1]], [[0, 0], [1, 0], [0.5, -0.1]], undefined, 0.5), null, 'too small')
  // Lips outlined the wrong way round give the same geometry (the upper lip stays the one that moves up).
  const sw = autoSplit(mouth())!
  const swapped = mouthGeometry(sw.lower, sw.upper, sw.corners, 0.6)!
  assert.deepEqual([swapped.upper, swapped.lower, swapped.top, swapped.bottom], [sw.upper, sw.lower, g.top, g.bottom])
  // Corners given right-to-left are put in order.
  const s = autoSplit(mouth())!
  assert.ok(near(mouthGeometry(s.upper, s.lower, [s.corners[1], s.corners[0]], 0.5)!.u[0], 1))
})

test('closed and neutral: nothing moves', () => {
  const g = geo()
  const m = mouthMotion(g, 0, 0)
  for (const p of faceMesh(g, m).src) for (const side of [0, 1] as const) assert.ok(displace(g, m, p, side).every((v) => v === 0))
  assert.ok(area(gapPolygon(g, m)) < 1e-9)
})

test('opening parts the lips; wide stretches, round narrows', () => {
  const g = geo()
  const open = mouthMotion(g, 1, 0)
  const [ux, uy] = displace(g, open, [200, 295], 0)
  const [lx, ly] = displace(g, open, [200, 305], 1)
  assert.ok(uy < -1 && ly > 10 && Math.abs(ux) < 1e-9 && Math.abs(lx) < 1e-9, 'upper up a little, lower down more')
  assert.ok(ly > -uy * 2)
  // Nothing tears at the corners: the lips meet there.
  assert.deepEqual(displace(g, open, [160, 300], 0), displace(g, open, [160, 300], 1))
  assert.ok(area(gapPolygon(g, open)) > 200)
  const wide = mouthMotion(g, 0.5, 1)
  const round = mouthMotion(g, 0.5, -1)
  assert.ok(displace(g, wide, [240, 300], 0)[0] > 1 && displace(g, wide, [160, 300], 0)[0] < -1, 'corners out')
  assert.ok(displace(g, round, [240, 300], 0)[0] < -1 && displace(g, round, [160, 300], 0)[0] > 1, 'corners in')
  assert.ok(area(gapPolygon(g, wide)) < area(gapPolygon(g, mouthMotion(g, 0.5, 0))), 'wide opens less high')
  // Out-of-range input is clamped.
  assert.deepEqual(mouthMotion(g, 5, -9), mouthMotion(g, 1, -1))
  assert.deepEqual(mouthMotion(g, Number.NaN, Number.NaN), mouthMotion(g, 0, 0))
})

test('the face follows gently and is still at the warp radius', () => {
  const g = geo(0.6)
  const m = mouthMotion(g, 1, 1)
  const chin = (dy: number) => displace(g, m, [200, 312 + dy], 1)[1]
  assert.ok(chin(0) > chin(g.radius * 0.3) && chin(g.radius * 0.3) > chin(g.radius * 0.7) && chin(g.radius * 0.7) > 0, 'chin falls off')
  assert.equal(chin(g.radius + 1), 0)
  assert.ok(displace(g, m, [240 + g.radius * 0.3, 300], 0)[0] > 0, 'cheek beside the corner is pulled out')
  // On the seam line beside the mouth both halves move the same way, so the face never tears outside the opening.
  for (const p of [[250, 300], [300, 301], [140, 299], [100, 300], [330, 300]] as Point[])
    assert.deepEqual(displace(g, m, p, 0).map((v) => v.toFixed(9)), displace(g, m, p, 1).map((v) => v.toFixed(9)), `${p}`)
  // Warp 0: no face mesh (radius 0); the lips move as a whole, their edges included (no smeared rim).
  const g0 = geo(0)
  const m0 = mouthMotion(g0, 1, 0)
  assert.equal(g0.radius, 0)
  const lo = lipMesh(g0, m0, 'lower')
  const moved = lo.src.map((s, i) => lo.dst[i][1] - s[1]).filter((_, i) => Math.abs(lo.src[i][0] - 200) < 1)
  assert.ok(moved.length >= 4 && moved.every((d) => Math.abs(d - moved[0]) < 1e-9 && d > 10), `${moved}`)
  // The jaw moves as a whole far below the mouth, not just a column under it.
  const j = mouthMotion(g, 1, 0)
  assert.ok(displace(g, j, [250, 312 + g.radius * 0.5], 1)[1] > 0.3 * displace(g, j, [200, 312 + g.radius * 0.5], 1)[1])
})

test('meshes: fixed outline, no folds, affine maps', () => {
  for (const warp of [0.1, 0.6, 1])
    for (const [o, w] of [[1, 0], [1, 1], [1, -1], [0.3, 0.4], [0, -1]]) {
      const g = geo(warp, mouth(200, 300, 40, 12, 15))
      const m = mouthMotion(g, o, w)
      const f = faceMesh(g, m)
      const out = faceOutline(g)
      const xs = f.src.map((p, i) => [p, f.dst[i]] as const)
      // The outermost rows and columns never move, and they lie on the outline.
      const cols = 19
      const rows = f.src.length / cols
      xs.forEach(([s, d], i) => {
        const edge = i < cols || i >= cols * (rows - 1) || i % cols === 0 || i % cols === cols - 1
        if (edge) assert.ok(near(s[0], d[0], 1e-9) && near(s[1], d[1], 1e-9), `edge vertex ${i} moved`)
      })
      for (const k of [0, cols - 1, cols * rows - 1, cols * (rows - 1)]) assert.ok(out.some((q) => near(q[0], f.src[k][0]) && near(q[1], f.src[k][1])))
      for (const mesh of [f, lipMesh(g, m, 'upper'), lipMesh(g, m, 'lower')])
        for (const [a, b, c] of mesh.tris) {
          const s = triArea(mesh.src[a], mesh.src[b], mesh.src[c])
          const d = triArea(mesh.dst[a], mesh.dst[b], mesh.dst[c])
          assert.ok(Math.sign(s) === Math.sign(d) && Math.abs(d) > 1e-9, `fold at warp ${warp}, open ${o}, wide ${w}`)
        }
    }
  const s: [Point, Point, Point] = [[0, 0], [10, 0], [0, 10]]
  const d: [Point, Point, Point] = [[5, 5], [25, 8], [3, 22]]
  const m = triAffine(s, d)!
  s.forEach(([x, y], i) => {
    assert.ok(near(m[0] * x + m[2] * y + m[4], d[i][0]) && near(m[1] * x + m[3] * y + m[5], d[i][1]))
  })
  assert.equal(triAffine([[0, 0], [1, 1], [2, 2]], d), null)
  // Each edge moves out by the given amount (here the legs of the right angle: x = -1 and y = -1).
  const gr = grow(s, 1)
  assert.ok(near(gr[0][0], -1) && near(gr[0][1], -1) && Math.abs(triArea(...gr)) > Math.abs(triArea(...s)))
  const sliver = grow([[0, 0], [100, 0], [0, 1]], 1)
  assert.ok(sliver.every(([x, y], i) => Math.hypot(x - [[0, 0], [100, 0], [0, 1]][i][0], y - [[0, 0], [100, 0], [0, 1]][i][1]) <= 3 + 1e-9), 'sharp corners capped')
})

test('a tilted mouth moves along its own axis', () => {
  const flat = geo(0.6)
  const r = (30 * Math.PI) / 180
  const ends: [Point, Point] = [[200 - 40 * Math.cos(r), 300 - 40 * Math.sin(r)], [200 + 40 * Math.cos(r), 300 + 40 * Math.sin(r)]]
  const tilt = geo(0.6, mouth(200, 300, 40, 12, 30), ends)
  const a = displace(flat, mouthMotion(flat, 1, 0), [200, 305], 1)
  const p: Point = [200 - 5 * Math.sin(r), 300 + 5 * Math.cos(r)]
  const b = displace(tilt, mouthMotion(tilt, 1, 0), p, 1)
  assert.ok(near(Math.hypot(...a), Math.hypot(...b), 0.05), `${a} vs ${b}`)
  assert.ok(near(b[0], -Math.sin(r) * a[1], 0.05) && near(b[1], Math.cos(r) * a[1], 0.05))
})

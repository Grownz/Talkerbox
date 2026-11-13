import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFill, dilate, fillCrop, fillPolygons, maskBox, movingParts, overlayColours, pushPull, rasterize, regionSig } from '../src/lib/fillUnder.ts'
import type { PartRole, Point } from '../src/lib/rig.ts'

const sq = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const part = (id: string, role: PartRole, polygon: Point[], parent?: string) => ({ id, role, polygon, parent })

test('moving parts: limbs and everything hanging on them, not eyes, mouth or body', () => {
  const parts = [
    part('arm-l', 'armL', sq(0.1, 0.1, 0.2, 0.5)),
    part('hand-l', 'handL', sq(0.1, 0.5, 0.2, 0.6), 'arm-l'),
    part('ring', 'custom', sq(0.1, 0.55, 0.12, 0.57), 'hand-l'),
    part('eye-l', 'eyeL', sq(0.4, 0.1, 0.45, 0.12)),
    part('mouth', 'mouth', sq(0.4, 0.2, 0.5, 0.25)),
    part('body', 'body', sq(0.3, 0.3, 0.7, 0.9)),
    part('hand-r', 'handR', sq(0.8, 0.5, 0.9, 0.6)), // no arm: does not move
    part('leg-r', 'legR', sq(0.5, 0.9, 0.6, 1)),
  ]
  assert.deepEqual([...movingParts(parts)].sort(), ['arm-l', 'hand-l', 'leg-r', 'ring'])
  assert.equal(fillPolygons(parts).length, 4)
  // A parent loop never hangs.
  assert.equal(movingParts([part('a', 'custom', sq(0, 0, 1, 1), 'b'), part('b', 'custom', sq(0, 0, 1, 1), 'a')]).size, 0)
})

test('region signature changes with the moving polygons only', () => {
  const a = [sq(0.1, 0.1, 0.2, 0.5)]
  assert.equal(regionSig(a), regionSig([sq(0.1, 0.1, 0.2, 0.5)]))
  assert.notEqual(regionSig(a), regionSig([sq(0.1, 0.1, 0.2, 0.51)]))
  assert.match(regionSig(a), /^[0-9a-f]{8}$/)
})

test('rasterize uses pixel centres, unions polygons; dilate grows by whole pixels', () => {
  const m = rasterize([sq(0.25, 0.25, 0.75, 0.75), sq(0, 0, 0.1, 0.1)], 8, 8)
  assert.equal(m.reduce((s, v) => s + v, 0), 16 + 1) // 4x4 square plus one corner pixel
  assert.equal(m[2 * 8 + 2], 1)
  assert.equal(m[1 * 8 + 1], 0)
  assert.deepEqual(maskBox(m, 8, 8), [0, 0, 6, 6])
  const d = dilate(m, 8, 8, 1)
  assert.equal(d[1 * 8 + 2], 1, 'grown by one')
  assert.equal(d[1 * 8 + 1], 0, '4-neighbour steps leave the diagonal')
  assert.equal(maskBox(new Uint8Array(4), 2, 2), null)
})

test('push-pull fills a hole from its surroundings and fades to transparent at the mask edge', () => {
  const w = 32
  const h = 32
  // Left half opaque red, right half opaque blue; a hole across the middle.
  const img = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) img.set(i % w < 16 ? [200, 0, 0, 255] : [0, 0, 200, 255], i * 4)
  const hole = rasterize([sq(0.25, 0.375, 0.75, 0.625)], w, h)
  pushPull(img, hole, w, h)
  const px = (x: number, y: number) => [...img.slice((y * w + x) * 4, (y * w + x) * 4 + 4)]
  assert.ok(px(9, 16)[0] > 150 && px(9, 16)[2] < 60, `left side stays red: ${px(9, 16)}`)
  assert.ok(px(22, 16)[2] > 150 && px(22, 16)[0] < 60, `right side stays blue: ${px(22, 16)}`)
  assert.ok(px(16, 16).every((v, k) => k === 3 || v < 200) && px(16, 16)[3] === 255, 'middle blends, fully opaque')
  assert.deepEqual(px(0, 0), [200, 0, 0, 255], 'known pixels are untouched')
  // Transparent around the figure: a hole at the edge of the opaque area fades out instead of smearing colour in.
  const fig = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) if (i % w < 16) fig.set([0, 200, 0, 255], i * 4)
  const edge = rasterize([sq(0.375, 0.25, 0.625, 0.75)], w, h)
  pushPull(fig, edge, w, h)
  const a = (x: number) => fig[(16 * w + x) * 4 + 3]
  assert.ok(a(12) > a(19) && a(19) < 128, `alpha falls towards the outside: ${a(12)} > ${a(19)}`)
  assert.ok(fig[(16 * w + 12) * 4 + 1] > 150, 'the colour stays green where it is visible')
})

test('fill modes: transparent clears the hole, classic fills it, AI colours keep the classic alpha', () => {
  const img = new Uint8ClampedArray(4 * 4 * 4).fill(255)
  const hole = rasterize([sq(0.25, 0.25, 0.75, 0.75)], 4, 4)
  const t = img.slice()
  applyFill(t, hole, 4, 4, 'transparent')
  assert.equal(t[(1 * 4 + 1) * 4 + 3], 0)
  assert.equal(t[3], 255)
  const n = img.slice()
  applyFill(n, hole, 4, 4, 'none')
  assert.deepEqual(n, img)
  const c = img.slice()
  c[(1 * 4 + 1) * 4] = 0 // the old part's pixel
  applyFill(c, hole, 4, 4, 'classic')
  assert.deepEqual([...c.slice(20, 24)], [255, 255, 255, 255])
  const ai = new Uint8ClampedArray(4 * 4 * 4)
  ai.set([10, 20, 30, 255], (1 * 4 + 1) * 4)
  overlayColours(c, ai, hole)
  assert.deepEqual([...c.slice(20, 24)], [10, 20, 30, 255])
  assert.deepEqual([...c.slice(0, 4)], [255, 255, 255, 255], 'outside the hole unchanged')
})

test('AI crop: the region plus context, square where possible, inside the image', () => {
  const crop = fillCrop([sq(0.4, 0.4, 0.5, 0.8)], 1000, 1000)!
  const [x0, y0, x1, y1] = crop
  assert.ok(x0 <= 400 && x1 >= 500 && y0 <= 400 && y1 >= 800)
  assert.equal(x1 - x0, y1 - y0, 'square')
  assert.ok(crop.every((v) => v >= 0 && v <= 1000))
  // Near the border it stays inside the image.
  const [a0, b0, a1, b1] = fillCrop([sq(0, 0.9, 0.05, 1)], 400, 300)!
  assert.ok(a0 === 0 && b1 === 300 && a1 <= 400 && b0 >= 0)
  assert.equal(fillCrop([], 10, 10), null)
})

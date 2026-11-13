import assert from 'node:assert/strict'
import { test } from 'node:test'
import { polygonArea, simplifyTo, traceLargest } from '../src/lib/maskGeometry.ts'
import { encodeSize, maskToPolygon, mergeMask, samPrompt, type Prompt } from '../src/lib/smartSelect.ts'
import { defaultPivot } from '../src/lib/rigRender.ts'

test('encoder size keeps the aspect with a long side of 1024', () => {
  assert.deepEqual(encodeSize(4000, 3000), [1024, 768])
  assert.deepEqual(encodeSize(300, 600), [512, 1024])
  assert.deepEqual(encodeSize(1024, 1024), [1024, 1024])
  assert.deepEqual(encodeSize(5000, 3), [1024, 1])
})

test('prompts map to encoder pixels with SAM labels', () => {
  const pts: Prompt[] = [
    { kind: 'point', p: [0.5, 0.25], positive: true },
    { kind: 'point', p: [0.1, 0.9], positive: false },
  ]
  // Without a box SAM needs one padding point labelled -1.
  assert.deepEqual(samPrompt(pts, 1024, 768), { points: [[512, 192], [102.4, 691.2], [0, 0]], labels: [1, 0, -1] })
  // The last box wins; its corners are ordered top left, bottom right whichever way it was dragged.
  const boxed: Prompt[] = [...pts, { kind: 'box', a: [0, 0], b: [0.1, 0.1] }, { kind: 'box', a: [0.75, 1], b: [0.25, 0.5] }]
  assert.deepEqual(samPrompt(boxed, 1000, 500)?.points.slice(2), [[250, 250], [750, 500]])
  assert.deepEqual(samPrompt(boxed, 1000, 500)?.labels, [1, 0, 2, 3])
  // A box alone is enough; background points alone or nothing are not.
  assert.deepEqual(samPrompt([{ kind: 'box', a: [0, 0], b: [1, 1] }], 10, 10)?.labels, [2, 3])
  assert.equal(samPrompt([pts[1]], 1024, 768), null)
  assert.equal(samPrompt([], 1024, 768), null)
})

test('merge adds a proposal, or removes it in erase mode', () => {
  const mask = Uint8Array.from([1, 1, 0, 0])
  const prop = Uint8Array.from([0, 1, 1, 0])
  assert.deepEqual([...mergeMask(mask, prop, false)], [1, 1, 1, 0])
  assert.deepEqual([...mergeMask(mask, prop, true)], [1, 0, 0, 0])
})

test('a decoder mask becomes an outline through the mask pipeline', () => {
  // Disc of radius 60 in a 256 x 192 mask, plus a stray speck that must be dropped (largest area only).
  const w = 256
  const h = 192
  const m = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = (x - 100) ** 2 + (y - 90) ** 2 < 60 ** 2 ? 1 : 0
  m[5 * w + 250] = 1
  const outline = simplifyTo(traceLargest(m, w, h), 0.7)
  assert.ok(outline.length >= 8 && outline.length < 200, `${outline.length} points`)
  const area = Math.abs(polygonArea(outline))
  assert.ok(Math.abs(area - Math.PI * 3600) / (Math.PI * 3600) < 0.05, `area ${area}`)
  assert.ok(outline.every(([x, y]) => x > 30 && x < 170 && y > 20 && y < 160))
})

test('a proposal becomes a part polygon: normalised, point cap, default pivot', () => {
  // An "arm": a 20 x 120 px bar in a 200 x 200 proposal.
  const w = 200
  const h = 200
  const m = new Uint8Array(w * h)
  for (let y = 40; y < 160; y++) for (let x = 90; x < 110; x++) m[y * w + x] = 1
  const poly = maskToPolygon(m, w, h, 1024)!
  assert.ok(poly.every(([x, y]) => x >= 0.44 && x <= 0.56 && y >= 0.19 && y <= 0.81), JSON.stringify(poly))
  const [px, py] = defaultPivot('armL', poly)
  assert.ok(Math.abs(px - 0.5) < 0.02 && py < 0.3, 'arm pivot at the middle of its top end')
  // A wiggly outline is simplified harder until it fits the cap.
  const n = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) n[y * w + x] = (x - 100) ** 2 + (y - 100) ** 2 < (60 + 8 * Math.sin(Math.atan2(y - 100, x - 100) * 24)) ** 2 ? 1 : 0
  assert.ok(maskToPolygon(n, w, h, 1024)!.length > 12)
  assert.ok(maskToPolygon(n, w, h, 12)!.length <= 12)
  assert.equal(maskToPolygon(new Uint8Array(w * h), w, h, 1024), null, 'empty proposal')
})

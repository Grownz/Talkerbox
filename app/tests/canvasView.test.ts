// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ImageView } from '../src/lib/canvasView.ts'

function setup() {
  let draws = 0
  const v = new ImageView(() => [200, 100], () => draws++)
  const wrap = { getBoundingClientRect: () => ({ width: 400, height: 300 }) } as HTMLElement
  const canvas = { width: 0, height: 0 } as HTMLCanvasElement
  ;(globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2
  v.resize(wrap, canvas)
  return { v, wrap, canvas, draws: () => draws }
}

test('resize sizes the backing store and fits the image; screen and image coordinates round-trip', () => {
  const { v, canvas, draws } = setup()
  assert.deepEqual([canvas.width, canvas.height, v.cw, v.ch], [800, 600, 400, 300])
  assert.ok(v.fitted && draws() === 1)
  const z = 1.88 // min(400 / 200, 300 / 100) * 0.94
  assert.ok(Math.abs(v.view.z - z) < 1e-12)
  const [sx, sy] = v.toScreen([0.5, 0.5])
  assert.ok(Math.abs(sx - 200) < 1e-9 && Math.abs(sy - 150) < 1e-9, 'image centre at canvas centre')
  assert.deepEqual(v.toNorm(sx, sy), [0.5, 0.5])
  assert.deepEqual(v.toNorm(-1000, 1e6), [0, 1], 'clamped to the image')
})

test('zoom and pan stop fitting; a resize then keeps the view, fit restores it', () => {
  const { v, wrap, canvas, draws } = setup()
  const before = v.toNorm(100, 100)
  v.zoomAt(2, 100, 100)
  assert.deepEqual(v.toNorm(100, 100), before, 'the point under the cursor stays')
  v.panBy(10, -5)
  const kept = { ...v.view }
  assert.equal(v.fitted, false)
  v.resize(wrap, canvas)
  assert.deepEqual(v.view, kept)
  v.zoomAt(1e9) // clamped at 4x fit but at least 32, around the centre
  assert.equal(v.view.z, 32)
  v.fit()
  assert.ok(v.fitted && Math.abs(v.view.z - 1.88) < 1e-12)
  assert.equal(draws(), 6)
})

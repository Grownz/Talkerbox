// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DOCK_MIN_WIDTH, dockNeedHeight, growWindow } from '../src/lib/dockSize.ts'

const frame = { w: 16, h: 39 } // Windows 11 at 100 %: borders and title bar
const area = { x: 0, y: 0, w: 1920, h: 1032 } // 1080p minus the taskbar

test('the full sidebar width needs 1289 px (18vw >= 232 px, above the 1024 px rail breakpoint)', () => {
  assert.equal(DOCK_MIN_WIDTH, 1289)
  assert.ok(DOCK_MIN_WIDTH * 0.18 >= 232 && (DOCK_MIN_WIDTH - 1) * 0.18 < 232)
})

test('needed height: sidebar content with the full avatar, at least enough for the 45vh cap', () => {
  // A 215 px wide dock is 286.7 px tall; the 45vh cap then needs 286.7 / 0.45 = 637.1 px of window height.
  assert.equal(dockNeedHeight([100, 200], 4, 24, 215), Math.ceil(Math.max(100 + 200 + 215 * (4 / 3) + 8 + 24, (215 * 4) / 3 / 0.45)))
  assert.equal(dockNeedHeight([10], 0, 0, 215), 638) // the cap wins
  assert.equal(dockNeedHeight([300, 300], 4, 24, 215), Math.ceil(600 + 8 + 24 + (215 * 4) / 3)) // content wins
})

test('grows a small window in place', () => {
  const r = growWindow({ x: 100, y: 50, w: 736, h: 559 }, frame, area, { w: 1289, h: 760 })
  assert.deepEqual(r, { x: 100, y: 50, w: 1289 + 16, h: 760 + 39 })
})

test('never shrinks, and returns null when the window is already big enough', () => {
  assert.equal(growWindow({ x: 0, y: 0, w: 1600, h: 900 }, frame, area, { w: 1289, h: 760 }), null)
  // Wide enough but too short: only the height grows.
  assert.deepEqual(growWindow({ x: 0, y: 0, w: 1600, h: 600 }, frame, area, { w: 1289, h: 760 }), { x: 0, y: 0, w: 1600, h: 799 })
})

test('moves the window back inside the work area', () => {
  const r = growWindow({ x: 1000, y: 500, w: 736, h: 559 }, frame, area, { w: 1289, h: 760 })
  assert.deepEqual(r, { x: 1920 - 1305, y: 1032 - 799, w: 1305, h: 799 })
  // Work area of a second monitor to the left with a top taskbar.
  const left = { x: -1920, y: 40, w: 1920, h: 1040 }
  assert.deepEqual(growWindow({ x: -1900, y: 0, w: 800, h: 600 }, frame, left, { w: 1289, h: 760 }), { x: -1900, y: 40, w: 1305, h: 799 })
})

test('a monitor too small for the need gets the whole work area', () => {
  const small = { x: 0, y: 0, w: 1280, h: 680 } // e.g. 1920x1080 at 150 % in logical terms, physical here
  assert.deepEqual(growWindow({ x: 200, y: 100, w: 800, h: 560 }, frame, small, { w: 1289, h: 760 }), { x: 0, y: 0, w: 1280, h: 680 })
})

test('physical pixels: the caller scales the need, frames scale with the DPI', () => {
  const scale = 1.5
  const hi = { x: 0, y: 0, w: 2560, h: 1392 }
  const r = growWindow({ x: 0, y: 0, w: 1104, h: 838 }, { w: 24, h: 58 }, hi, { w: Math.ceil(1289 * scale), h: Math.ceil(760 * scale) })
  assert.deepEqual(r, { x: 0, y: 0, w: 1934 + 24, h: 1140 + 58 })
})

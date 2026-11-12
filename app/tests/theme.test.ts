import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveTheme } from '../src/lib/theme.ts'
import { collapseOrder } from '../src/lib/fit.ts'

test('stored theme wins over the system setting', () => {
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme('dark', false), 'dark')
})

test('no or invalid stored theme follows the system', () => {
  assert.equal(resolveTheme(null, true), 'dark')
  assert.equal(resolveTheme(null, false), 'light')
  assert.equal(resolveTheme('blue', true), 'dark')
})

test('toolbar buttons collapse lowest priority first, ties right to left', () => {
  assert.deepEqual(collapseOrder([1, 0, 0, 2]), [2, 1, 0, 3])
  assert.deepEqual(collapseOrder([]), [])
})

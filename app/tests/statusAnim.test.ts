import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_DELAY_MS, MIN_DELAY_MS, nextDelayMs, passMs } from '../src/lib/statusAnim.ts'

test('delay between passes stays within 60-600 s', () => {
  assert.equal(nextDelayMs(() => 0), 60_000)
  assert.equal(nextDelayMs(() => 0.5), 330_000)
  assert.ok(nextDelayMs(() => 0.999999) < 600_000)
  for (let i = 0; i < 1000; i++) {
    const d = nextDelayMs()
    assert.ok(d >= MIN_DELAY_MS && d < MAX_DELAY_MS, String(d))
  }
})

test('a pass moves at 5 px per second', () => {
  assert.equal(passMs(25), 5000)
  assert.equal(passMs(0), 0)
})

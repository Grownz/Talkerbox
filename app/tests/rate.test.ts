import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalRate, formatRate, liveRate } from '../src/lib/rate.ts'

// Chunks every 100 ms starting at t0 = 5000 (the 5 s before is prompt processing and must not count).
const stamps = Array.from({ length: 21 }, (_, i) => 5000 + i * 100) // 5000..7000

test('live rate ignores time before the first token', () => {
  assert.equal(liveRate(stamps, 7000), 10) // 20 tokens after the first in 2 s
})

test('live rate uses a rolling window', () => {
  // Window 1 s: tokens in (6000, 7000] = 10
  assert.equal(liveRate(stamps, 7000, 1000), 10)
  // Generation stalls for 1 s: the rate drops.
  assert.equal(liveRate(stamps, 8000, 2000), 5)
})

test('live rate needs data', () => {
  assert.equal(liveRate([], 1000), null)
  assert.equal(liveRate([1000], 2000), null)
  assert.equal(liveRate([1000, 1050], 1100), null) // less than 0.2 s of data
})

test('final rate prefers Ollama stats', () => {
  assert.equal(finalRate(50, 2_000_000_000, stamps), 25)
  assert.equal(finalRate(null, null, stamps), 10)
  assert.equal(finalRate(null, null, [1]), null)
})

test('formatting has one decimal', () => {
  assert.equal(formatRate(12.345), '12.3 tok/s')
  assert.equal(formatRate(7), '7.0 tok/s')
})

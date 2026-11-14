import assert from 'node:assert/strict'
import { test } from 'node:test'
import { envelope, testEnvelope } from '../src/lib/envelope.ts'
import { EnvelopeQueue, LEAD_MS } from '../src/lib/avatarQueue.ts'

const SR = 24000
const tone = (secs: number, amp: (t: number) => number) =>
  Float32Array.from({ length: Math.round(SR * secs) }, (_, i) => amp(i / SR) * Math.sin((2 * Math.PI * 220 * i) / SR))

test('silence gives a closed mouth', () => {
  const e = envelope(new Float32Array(SR), SR)
  assert.equal(e.length, 50)
  assert.ok(e.every((v) => v === 0))
})

test('near-silence noise is not amplified', () => {
  const e = envelope(tone(1, () => 0.001), SR)
  assert.ok(Math.max(...e) < 0.1)
})

test('steady tone settles at full opening', () => {
  const e = envelope(tone(1, () => 0.5), SR)
  assert.ok(e.slice(5).every((v) => v >= 0.98 && v <= 1), e.join(','))
})

test('ramp rises monotonically', () => {
  const e = envelope(tone(1, (t) => t), SR)
  for (let i = 1; i < e.length; i++) assert.ok(e[i] >= e[i - 1] - 0.02, `drop at ${i}`)
  assert.ok(e[2] < 0.2)
  assert.ok(e.at(-1)! > 0.9)
})

test('hop size sets the frame count', () => {
  const s = tone(1, () => 0.5)
  assert.equal(envelope(s, SR, 20).length, 50)
  assert.equal(envelope(s, SR, 40).length, 25)
  assert.equal(envelope(s, SR, 30).length, Math.ceil(SR / 720))
  assert.equal(envelope(new Float32Array(0), SR).length, 0)
})

// The mouth shows the sound LEAD_MS ahead, so the envelope plays LEAD_MS before its start time.
const L = LEAD_MS

test('queue plays an envelope LEAD_MS ahead of its start time and interpolates', () => {
  assert.ok(L >= 40 && L <= 80)
  const q = new EnvelopeQueue()
  q.push({ startMs: 1000, hopMs: 20, envelope: [0, 1, 0.5] })
  assert.equal(q.level(990 - L), 0)
  assert.equal(q.level(1000 - L), 0)
  assert.equal(q.level(1010 - L), 0.5)
  assert.equal(q.level(1020 - L), 1)
  assert.equal(q.level(1050 - L), 0.25)
  assert.equal(q.level(1060 - L), 0)
  assert.equal(q.size, 1, 'kept until its audio has ended')
  assert.equal(q.level(1060), 0)
  assert.equal(q.size, 0)
})

test('queue: shapes and closures lead by the same LEAD_MS', () => {
  const q = new EnvelopeQueue()
  q.push({ startMs: 1000, hopMs: 20, envelope: [1, 1, 1, 1], wide: [0, 0, 1, 1], fric: [0, 0, 0, 0], close: [0, 1, 0, 0] })
  assert.equal(q.sample(1020 - L).close, 1)
  assert.equal(q.sample(1040 - L).wide, 1)
  assert.equal(q.sample(1040 - L - 20).wide, 0)
  // Older senders without shape data still play.
  q.push({ startMs: 2000, hopMs: 20, envelope: [0.5] })
  // The first sentence has finished by now (ended counts it once); a stop is no finish.
  assert.deepEqual(q.sample(2000 - L), { level: 0.5, wide: 0, fric: 0, close: 0, ended: 1 })
  q.clear()
  assert.equal(q.sample(3000).ended, 1)
  q.push({ startMs: 3000, hopMs: 20, envelope: [1] })
  assert.equal(q.sample(3010).ended, 1)
  assert.equal(q.sample(3020).ended, 2)
})

test('queue handles future, overlapping and cleared sentences', () => {
  const q = new EnvelopeQueue()
  q.push({ startMs: 2000, hopMs: 20, envelope: [0.2, 0.2] })
  q.push({ startMs: 1000, hopMs: 20, envelope: [0.4, 0.4, 0.4] })
  q.push({ startMs: 1020, hopMs: 20, envelope: [0.8, 0.8] })
  assert.equal(q.level(1000 - L), 0.4)
  assert.equal(q.level(1030 - L), 0.8)
  assert.equal(q.level(1500 - L), 0)
  assert.equal(q.size, 1)
  assert.equal(q.level(2000 - L), 0.2)
  q.clear()
  assert.equal(q.level(2010 - L), 0)
})

test('test envelope looks like speech', () => {
  const e = testEnvelope(3000)
  assert.equal(e.length, 150)
  assert.ok(e.every((v) => v >= 0 && v <= 1))
  assert.ok(Math.max(...e) > 0.8)
  assert.ok(e.filter((v) => v === 0).length > 20, 'pauses between syllables and words')
  assert.deepEqual(testEnvelope(0), [])
})

test('queue ignores empty envelopes', () => {
  const q = new EnvelopeQueue()
  q.push({ startMs: 0, hopMs: 20, envelope: [] })
  q.push({ startMs: 0, hopMs: 0, envelope: [1] })
  assert.equal(q.size, 0)
})

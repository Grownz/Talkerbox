import assert from 'node:assert/strict'
import { test } from 'node:test'
import { envelope } from '../src/lib/envelope.ts'
import { fft, testVisemes, VISEMES, visemes } from '../src/lib/viseme.ts'
import { seeded } from '../src/lib/poseGen.ts'

const SR = 24000
/**
 * Voiced vowel: harmonics of f0 shaped by three formant resonances at the measured levels of an adult male voice
 * (Peterson & Barney 1952: formant frequencies `F` in Hz, levels `L` in dB relative to the first formant).
 */
function vowel(F: [number, number, number], L: [number, number, number], secs = 0.5, f0 = 120) {
  const amps: [number, number][] = []
  for (let f = f0; f < 5000; f += f0)
    amps.push([f, F.reduce((s, Fi, i) => s + 10 ** (L[i] / 20) / Math.sqrt(1 + ((f - Fi) / 50) ** 2), 0)])
  const x = Float32Array.from({ length: Math.round(SR * secs) }, (_, i) =>
    amps.reduce((s, [f, a]) => s + a * Math.sin((2 * Math.PI * f * i) / SR), 0),
  )
  const peak = Math.max(...x.map(Math.abs))
  return x.map((v) => (v / peak) * 0.5)
}
const EE = (secs?: number) => vowel([270, 2290, 3010], [0, -20, -24], secs)
const OO = () => vowel([300, 870, 2240], [0, -16, -40])
const AH = () => vowel([730, 1090, 2440], [0, -4, -27])
const mid = (xs: number[]) => xs.slice(3, -3).reduce((a, b) => a + b, 0) / (xs.length - 6)

test('fft finds a pure tone in its bin', () => {
  const n = 64
  const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n))
  const im = new Float64Array(n)
  fft(re, im)
  const mag = Array.from(re, (r, i) => Math.hypot(r, im[i]))
  assert.ok(Math.abs(mag[5] - n / 2) < 1e-9 && Math.abs(mag[59] - n / 2) < 1e-9)
  assert.ok(mag.every((m, i) => i === 5 || i === 59 || m < 1e-9))
})

test('vowels: EE is wide, OO is round, AH is neutral', () => {
  const ee = visemes(EE(), SR)
  const oo = visemes(OO(), SR)
  const ah = visemes(AH(), SR)
  assert.ok(mid(ee.wide) > 0.6, `EE ${mid(ee.wide)}`)
  assert.ok(mid(oo.wide) < -0.6, `OO ${mid(oo.wide)}`)
  assert.ok(Math.abs(mid(ah.wide)) < 0.3, `AH ${mid(ah.wide)}`)
  for (const v of [ee, oo, ah]) assert.ok(mid(v.fric) < 0.2, 'vowels are not hiss')
})

test('hiss reads as teeth (F, V, S)', () => {
  const rnd = seeded(1)
  const noise = Float32Array.from({ length: SR / 2 }, () => (rnd() - 0.5) * 0.3)
  assert.ok(mid(visemes(noise, SR).fric) > 0.6)
})

test('silence and quiet frames are neutral, frames match the envelope', () => {
  const s = new Float32Array(SR)
  assert.deepEqual(visemes(s, SR), { wide: Array(50).fill(0), fric: Array(50).fill(0) })
  const v = EE(1)
  const withGap = new Float32Array(SR * 2)
  withGap.set(v, SR)
  const r = visemes(withGap, SR)
  assert.equal(r.wide.length, envelope(withGap, SR).length)
  assert.ok(r.wide.slice(0, 45).every((x) => x === 0), 'leading silence is neutral')
  assert.equal(visemes(new Float32Array(0), SR).wide.length, 0)
  assert.equal(visemes(v, 44100, 20).wide.length, envelope(v, 44100, 20).length)
  for (const x of [...r.wide, ...r.fric]) assert.ok(Number.isFinite(x) && Math.abs(x) <= 1)
})

test('named shapes and test shapes stay in range', () => {
  for (const v of Object.values(VISEMES)) assert.ok(v.open >= 0 && v.open <= 1 && Math.abs(v.wide) <= 1)
  const t = testVisemes(150)
  assert.equal(t.wide.length, 150)
  assert.ok(t.wide.some((w) => w > 0.5) && t.wide.some((w) => w < -0.5) && t.fric.some((f) => f > 0.5))
})

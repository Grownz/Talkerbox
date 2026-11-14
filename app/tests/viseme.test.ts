import assert from 'node:assert/strict'
import { test } from 'node:test'
import { envelope } from '../src/lib/envelope.ts'
import { CLOSE_MAX_MS, CLOSE_MIN_MS, fft, testVisemes, VISEMES, visemes } from '../src/lib/viseme.ts'
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
  assert.deepEqual(visemes(s, SR), { wide: Array(50).fill(0), fric: Array(50).fill(0), close: Array(50).fill(0) })
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

const cat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0)
  return out
}
const silence = (ms: number) => new Float32Array(Math.round((SR * ms) / 1000))
/** Release burst of a labial stop: 10 ms of low-passed noise (diffuse, falling spectrum, not hiss). */
const burst = () => {
  const rnd = seeded(3)
  let y = 0
  return Float32Array.from({ length: SR / 100 }, () => (y += 0.3 * ((rnd() - 0.5) * 0.8 - y)))
}
/** Nasal murmur (M): a weak low hum below the vowel band. */
const hum = (ms: number) => Float32Array.from(silence(ms), (_, i) => 0.05 * Math.sin((2 * Math.PI * 200 * i) / SR))
const closedFrames = (c: number[]) => c.filter((v) => v > 0).length

test('a stop closure (gap + burst) between vowels closes the lips, neutral shape there', () => {
  const r = visemes(cat(AH(), silence(60), burst(), AH()), SR)
  const n = closedFrames(r.close)
  assert.ok(n >= 2 && n * 20 <= CLOSE_MAX_MS, `closed frames ${n}: ${r.close.join('')}`)
  const at = r.close.indexOf(1)
  assert.ok(at >= 24 && at <= 27, `closure at frame ${at}`) // the gap starts at 500 ms = frame 25
  r.close.forEach((c, i) => c && assert.ok(r.wide[i] === 0 && r.fric[i] === 0))
})

test('a nasal hum between vowels (M) closes the lips', () => {
  const r = visemes(cat(EE(), hum(80), AH()), SR)
  assert.ok(closedFrames(r.close) >= 2, r.close.join(''))
})

test('no closure for a word gap, a long pause, continuous voice, a sentence start or a hiss onset', () => {
  assert.equal(closedFrames(visemes(cat(AH(), silence(60), AH()), SR).close), 0, 'silent word gap, no burst')
  assert.equal(closedFrames(visemes(cat(AH(), silence(400), burst(), AH()), SR).close), 0, 'long pause')
  assert.equal(closedFrames(visemes(cat(AH(), hum(300), AH()), SR).close), 0, 'long hum')
  // Continuous vowels with a shape change and a smooth syllable-like loudness dip.
  const v = cat(AH(), EE(), OO())
  const dip = v.map((x, i) => x * (0.55 + 0.45 * Math.cos((2 * Math.PI * 4 * i) / SR)))
  assert.equal(closedFrames(visemes(v, SR).close), 0, 'vowel changes')
  assert.equal(closedFrames(visemes(dip, SR).close), 0, 'loudness dips')
  assert.equal(closedFrames(visemes(cat(silence(60), burst(), AH()), SR).close), 0, 'sentence start')
  const rnd = seeded(5)
  const ss = Float32Array.from(silence(80), () => (rnd() - 0.5) * 0.6)
  assert.equal(closedFrames(visemes(cat(AH(), silence(60), ss, AH()), SR).close), 0, 'S after a gap')
  assert.ok(CLOSE_MIN_MS >= 30 && CLOSE_MAX_MS <= 120)
})

test('named shapes and test shapes stay in range', () => {
  for (const v of Object.values(VISEMES)) assert.ok(v.open >= 0 && v.open <= 1 && Math.abs(v.wide) <= 1)
  const t = testVisemes(150)
  assert.equal(t.wide.length, 150)
  assert.ok(t.wide.some((w) => w > 0.5) && t.wide.some((w) => w < -0.5) && t.fric.some((f) => f > 0.5))
})

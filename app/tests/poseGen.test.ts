import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ARM_LIFT,
  ARM_SWING,
  BLINK_CLOSE_MS,
  BLINK_GAP_MAX,
  BLINK_GAP_MEDIAN,
  BLINK_GAP_MIN,
  BLINK_MS,
  BLINK_OPEN_MS,
  DOUBLE_GAP_MAX,
  DOUBLE_GAP_MIN,
  DOUBLE_P,
  MAX_ANGLE,
  PoseGen,
  seeded,
} from '../src/lib/poseGen.ts'
import { REST, type Pose } from '../src/lib/rigRender.ts'

/** Runs `gen` at 60 fps from `t0` for `ms`, with loudness `level(t)`; returns every pose with its time. */
function run(gen: PoseGen, t0: number, ms: number, level: (t: number) => number, still = false) {
  const out: { t: number; p: Pose }[] = []
  for (let t = t0; t <= t0 + ms; t += 1000 / 60) out.push({ t, p: gen.step(t, level(t), still) })
  return out
}
const peak = (xs: number[]) => Math.max(...xs.map(Math.abs))

test('seeded RNG is deterministic and in 0..1', () => {
  const a = seeded(42)
  const b = seeded(42)
  const xs = Array.from({ length: 1000 }, () => a())
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()))
  assert.ok(xs.every((x) => x >= 0 && x < 1))
  assert.notEqual(seeded(1)(), seeded(2)())
})

test('the same seed gives the same poses', () => {
  const speak = (t: number) => (t > 500 ? 0.8 : 0)
  assert.deepEqual(run(new PoseGen(seeded(7)), 0, 4000, speak), run(new PoseGen(seeded(7)), 0, 4000, speak))
  assert.notDeepEqual(run(new PoseGen(seeded(7)), 0, 4000, speak), run(new PoseGen(seeded(8)), 0, 4000, speak))
})

/** Times at which a blink starts (closure rises from 0). */
const blinkStarts = (frames: { t: number; p: Pose }[]) =>
  frames.filter((f, i) => i > 0 && f.p.blink > 0 && frames[i - 1].p.blink === 0).map((f) => f.t)

test('blink gaps: lognormal around 2-6 s, clamped, about 10 % doubles, no blink storm', () => {
  const frames = run(new PoseGen(seeded(3)), 0, 30 * 60_000, () => 0)
  for (const f of frames) assert.ok(f.p.blink >= 0 && f.p.blink <= 1)
  assert.ok(Math.max(...frames.map((f) => f.p.blink)) > 0.95, 'the eyes close fully')
  const starts = blinkStarts(frames)
  const gaps = starts.slice(1).map((s, i) => s - starts[i] - BLINK_MS)
  const doubles = gaps.filter((g) => g < BLINK_GAP_MIN - 50)
  const normal = gaps.filter((g) => g >= BLINK_GAP_MIN - 50).sort((a, b) => a - b)
  for (const g of doubles) assert.ok(g >= DOUBLE_GAP_MIN - 50 && g <= DOUBLE_GAP_MAX + 50, `double gap ${g}`)
  for (let i = 1; i < gaps.length; i++) assert.ok(!(gaps[i] < BLINK_GAP_MIN - 50 && gaps[i - 1] < BLINK_GAP_MIN - 50), 'no triple blinks')
  assert.ok(normal[0] >= BLINK_GAP_MIN - 50 && normal.at(-1)! <= BLINK_GAP_MAX + 50, 'clamped')
  const median = normal[normal.length >> 1]
  assert.ok(median > BLINK_GAP_MEDIAN * 0.85 && median < BLINK_GAP_MEDIAN * 1.15, `median ${median}`)
  const inRange = normal.filter((g) => g >= 2000 && g <= 6000).length / normal.length
  assert.ok(inRange > 0.8, `${inRange} within 2-6 s`)
  const share = doubles.length / normal.length
  assert.ok(share > DOUBLE_P * 0.5 && share < DOUBLE_P * 1.6, `doubles ${share}`)
  assert.ok(starts.length / 30 < 25, `${starts.length / 30} blinks a minute`)
})

test('a forced double blink: the second follows the reopened first after 150-250 ms', () => {
  const frames = run(new PoseGen(() => 0.05), 0, 20_000, () => 0) // 0.05 < DOUBLE_P: the first blink doubles
  const [a, b, c] = blinkStarts(frames)
  const g = b - a - BLINK_MS
  assert.ok(g >= DOUBLE_GAP_MIN - 50 && g <= DOUBLE_GAP_MAX + 50, `double gap ${g}`)
  assert.ok(c - b - BLINK_MS >= BLINK_GAP_MIN - 50, 'then a normal gap, never a third')
})

test('blink shape: closes in BLINK_CLOSE_MS, opens more slowly in BLINK_OPEN_MS', () => {
  const at = PoseGen.blinkCurve
  assert.ok(BLINK_CLOSE_MS >= 60 && BLINK_CLOSE_MS <= 70 && BLINK_OPEN_MS >= 100 && BLINK_OPEN_MS <= 150)
  assert.equal(at(0), 0)
  assert.equal(at(BLINK_CLOSE_MS), 1)
  assert.ok(Math.abs(at(BLINK_CLOSE_MS / 2) - 0.5) < 1e-9 && Math.abs(at(BLINK_CLOSE_MS + BLINK_OPEN_MS / 2) - 0.5) < 1e-9)
  assert.equal(at(BLINK_MS), 0)
  assert.equal(at(-5), 0)
  for (let u = 1; u < BLINK_CLOSE_MS; u++) assert.ok(at(u) > at(u - 1), 'rises while closing')
  for (let u = BLINK_CLOSE_MS + 1; u <= BLINK_MS; u++) assert.ok(at(u) < at(u - 1), 'falls while opening')
  // The rendered blink follows the curve: peak BLINK_CLOSE_MS after the start.
  const frames: { t: number; p: Pose }[] = []
  const gen = new PoseGen(seeded(3))
  for (let t = 0; t <= 10_000; t++) frames.push({ t, p: gen.step(t, 0) })
  const s = blinkStarts(frames)[0] - 1
  const peak = frames.filter((f) => f.t >= s && f.t <= s + BLINK_MS).reduce((m, f) => (f.p.blink > m.p.blink ? f : m))
  assert.ok(Math.abs(peak.t - s - BLINK_CLOSE_MS) <= 1, `peak at ${peak.t - s}`)
})

test('a finished sentence blinks once, with BLINK_MIN_SPACING between blinks', () => {
  // RNG 0.95: no double blinks, first random blink ~7.5 s away.
  const gen = new PoseGen(() => 0.95)
  const ends = (t: number) => (t < 3000 ? 0 : t < 3500 ? 1 : t < 4500 ? 2 : 4) // 2 -> 4: two ends in one skipped frame
  const frames: { t: number; p: Pose }[] = []
  for (let t = 0; t <= 6000; t += 1000 / 60) frames.push({ t, p: gen.step(t, 0.5, false, { wide: 0, fric: 0, ended: ends(t) }) })
  const starts = blinkStarts(frames)
  assert.equal(starts.length, 2, `${starts}`)
  assert.ok(starts[0] >= 3000 && starts[0] < 3040, 'blinks at the first sentence end')
  assert.ok(starts[1] >= 4500 && starts[1] < 4540, 'the end at 3.5 s is too close to the last blink, 4.5 s is not')
  // Reduced motion keeps the sentence-end blink.
  const g2 = new PoseGen(() => 0.95)
  g2.step(0, 0, true, { wide: 0, fric: 0, ended: 0 })
  g2.step(1000, 0, true, { wide: 0, fric: 0, ended: 1 })
  assert.ok(g2.step(1000 + BLINK_CLOSE_MS, 0, true, { wide: 0, fric: 0, ended: 1 }).blink > 0.99)
})

test('gestures grow with speech energy and stay within the limits', () => {
  const loud = run(new PoseGen(seeded(5)), 0, 8000, () => 1).slice(180)
  const soft = run(new PoseGen(seeded(5)), 0, 8000, () => 0.25).slice(180)
  const quiet = run(new PoseGen(seeded(5)), 0, 8000, () => 0).slice(180)
  for (const k of ['armL', 'armR', 'legL', 'legR'] as const) {
    assert.ok(peak(loud.map((f) => f.p[k])) > peak(soft.map((f) => f.p[k])) * 2, k)
    assert.ok(peak(quiet.map((f) => f.p[k])) < 1e-9, `${k} rests while silent`)
  }
  assert.ok(peak(loud.map((f) => f.p.armL)) > ARM_SWING * 0.5)
  assert.ok(peak(loud.map((f) => f.p.armL)) <= ARM_LIFT + ARM_SWING + 1e-9)
  assert.ok(peak(loud.map((f) => f.p.legL)) < peak(loud.map((f) => f.p.armL)) / 3, 'legs only shift a little')
  // The limbs move independently.
  assert.notDeepEqual(loud.map((f) => f.p.armL.toFixed(3)), loud.map((f) => (-f.p.armR).toFixed(3)))
  // Out-of-range input is clamped.
  for (const f of run(new PoseGen(seeded(9)), 0, 3000, (t) => (t % 2 ? 50 : Number.NaN)))
    for (const k of ['armL', 'armR', 'legL', 'legR'] as const) assert.ok(Math.abs(f.p[k]) <= MAX_ANGLE && Number.isFinite(f.p[k]))
})

test('limbs ease back to rest after speech', () => {
  const gen = new PoseGen(seeded(11))
  run(gen, 0, 5000, () => 0.9)
  const after = run(gen, 5000, 6000, () => 0)
  const late = after.filter((f) => f.t > 9000)
  assert.ok(peak(late.map((f) => f.p.armL)) < 0.5 && peak(late.map((f) => f.p.armR)) < 0.5, 'arms back at rest')
  // No snap: the first silent frames still carry most of the motion's energy.
  assert.ok(gen.energy < 0.01)
  const first = after.slice(0, 5).map((f) => Math.abs(f.p.armL) + Math.abs(f.p.armR))
  assert.ok(first.some((v) => v > 1))
})

test('mouth follows the loudness smoothly', () => {
  const gen = new PoseGen(seeded(1))
  const frames = run(gen, 0, 1000, (t) => (t < 500 ? 1 : 0))
  const at = (ms: number) => frames.find((f) => f.t >= ms)!.p.mouth
  assert.ok(at(16) < 0.8, 'no jump on the first frame')
  assert.ok(at(200) > 0.95)
  assert.ok(at(520) > 0.3 && at(520) < 0.95, 'closes over a few frames')
  assert.ok(at(900) < 0.01)
})

test('reduced motion: no sway or gestures, mouth and blink still work', () => {
  const frames = run(new PoseGen(seeded(2)), 0, 8000, () => 1, true)
  for (const f of frames) for (const k of ['armL', 'armR', 'legL', 'legR', 'sway'] as const) assert.equal(f.p[k], 0)
  assert.ok(frames.at(-1)!.p.mouth > 0.9)
  assert.ok(frames.some((f) => f.p.blink > 0))
})

test('viseme shape eases in, hiss closes towards the teeth, silence is neutral', () => {
  const gen = new PoseGen(seeded(6))
  const at: Pose[] = []
  for (let t = 0; t <= 2000; t += 1000 / 60) at.push(gen.step(t, t < 1000 ? 1 : 0, false, { wide: -1, fric: 0 }))
  assert.ok(at[1].wide > -0.5, 'no jump to the new shape')
  assert.ok(at[50].wide < -0.95, 'round after a few frames')
  assert.ok(at.at(-1)!.wide > -0.01, 'neutral again while silent')
  const g2 = new PoseGen(seeded(6))
  let p = REST
  for (let t = 0; t <= 1000; t += 1000 / 60) p = g2.step(t, 1, false, { wide: 0, fric: 1 })
  assert.ok(p.mouth < 0.5 && p.mouth > 0.3, `teeth: mouth ${p.mouth}`)
  assert.ok(p.wide > 0.3, 'teeth show a little wider')
  // Out-of-range shapes are clamped; no shape keeps the Phase 5 loudness-only behaviour.
  assert.ok(Math.abs(new PoseGen(seeded(1)).step(0, 1, false, { wide: 9, fric: Number.NaN }).wide) <= 1)
  assert.equal(new PoseGen(seeded(1)).step(0, 1).wide, 0)
})

test('a lip closure (P, B, M) shuts the mouth within a few frames and releases into the next shape', () => {
  const gen = new PoseGen(seeded(6))
  const step = (t: number, close: number, wide = 1) => gen.step(t, 0.8, false, { wide, fric: 0, close })
  let p = REST
  for (let t = 0; t <= 500; t += 1000 / 60) p = step(t, 0)
  assert.ok(p.mouth > 0.7 && p.wide > 0.9)
  const shut = [520, 537, 553].map((t) => step(t, 1)) // a ~40 ms closure at 60 fps
  assert.ok(shut[1].mouth < 0.1, `mouth ${shut[1].mouth}`)
  assert.ok(shut[2].mouth < 0.02 && shut[2].wide < p.wide)
  for (let t = 570; t <= 800; t += 1000 / 60) p = step(t, 0, -1)
  assert.ok(p.mouth > 0.7 && p.wide < -0.9, 'opens into the next vowel')
})

test('a long pause between frames does not jump', () => {
  const gen = new PoseGen(seeded(4))
  gen.step(0, 0)
  const p = gen.step(60_000, 1) // e.g. after the window was hidden
  assert.ok(p.mouth < 0.99 && gen.energy < 0.3)
})

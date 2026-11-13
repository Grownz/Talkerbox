import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ARM_LIFT, ARM_SWING, BLINK_GAP_MAX, BLINK_GAP_MIN, BLINK_MS, MAX_ANGLE, PoseGen, seeded } from '../src/lib/poseGen.ts'
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

test('blinks come every 2-6 s and last about 150 ms', () => {
  const gen = new PoseGen(seeded(3))
  const frames = run(gen, 0, 60_000, () => 0)
  const starts: number[] = []
  let closed = 0
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].p.blink > 0 && frames[i - 1].p.blink === 0) starts.push(frames[i].t)
    closed = Math.max(closed, frames[i].p.blink)
    assert.ok(frames[i].p.blink >= 0 && frames[i].p.blink <= 1)
  }
  assert.ok(starts.length >= 60 / 6 - 1 && starts.length <= 60 / 2 + 1, `${starts.length} blinks`)
  assert.ok(starts[0] >= BLINK_GAP_MIN - 20 && starts[0] <= BLINK_GAP_MAX + 20)
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1]
    assert.ok(gap >= BLINK_GAP_MIN + BLINK_MS - 40 && gap <= BLINK_GAP_MAX + BLINK_MS + 40, `gap ${gap}`)
  }
  assert.ok(closed > 0.9, 'the eyes close fully')
  // Each blink is open again within BLINK_MS.
  const s = starts[1]
  assert.equal(frames.find((f) => f.t > s + BLINK_MS + 20)!.p.blink, 0)
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

test('a long pause between frames does not jump', () => {
  const gen = new PoseGen(seeded(4))
  gen.step(0, 0)
  const p = gen.step(60_000, 1) // e.g. after the window was hidden
  assert.ok(p.mouth < 0.99 && gen.energy < 0.3)
})

// Pose generator for the avatar window: turns the loudness of the speech into a Pose every frame.
// Pure apart from the injected clock values and RNG, so it is unit-tested (tests/poseGen.test.ts).
import { REST, type Pose } from './rigRender.ts'

export const BLINK_MS = 150
export const BLINK_GAP_MIN = 2000
export const BLINK_GAP_MAX = 6000
/** Largest gesture swing at full speech energy, in degrees (arms; legs only shift the weight a little). */
export const ARM_SWING = 22
export const ARM_LIFT = 8
export const LEG_SWING = 3
export const MAX_ANGLE = 60

/** Small seeded RNG (mulberry32) returning 0..1, for reproducible tests. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clampAngle = (v: number) => Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, v))
/** Exponential approach of `cur` to `to` over `dt` ms with time constant `tau` ms. */
const ease = (cur: number, to: number, dt: number, tau: number) => cur + (to - cur) * (1 - Math.exp(-dt / tau))

export class PoseGen {
  /** Smoothed loudness that drives the gestures (slow), and the mouth (fast). */
  energy = 0
  private mouth = 0
  private wide = 0
  private last: number | null = null
  private nextBlink: number
  // Per limb: two incommensurate sine frequencies (Hz) and phases, so the swing never visibly repeats.
  private osc: { f: [number, number]; p: [number, number] }[]
  private rng: () => number

  /** `t0`: the clock value of the first `step` (ms); `rng` 0..1 (`seeded` for tests). */
  constructor(rng: () => number = Math.random, t0 = 0) {
    this.rng = rng
    this.nextBlink = t0 + this.gap()
    this.osc = [0, 1, 2, 3].map(() => ({
      f: [0.35 + rng() * 0.2, 0.9 + rng() * 0.4],
      p: [rng() * Math.PI * 2, rng() * Math.PI * 2],
    }))
  }

  private gap() {
    return BLINK_GAP_MIN + this.rng() * (BLINK_GAP_MAX - BLINK_GAP_MIN)
  }

  /** Slow noisy oscillator of limb `i` at time `t` (ms), -1..1. */
  private wave(i: number, t: number) {
    const { f, p } = this.osc[i]
    const s = t / 1000
    return 0.65 * Math.sin(2 * Math.PI * f[0] * s + p[0]) + 0.35 * Math.sin(2 * Math.PI * f[1] * s + p[1])
  }

  /**
   * Pose at time `t` (ms, monotonic) for the current loudness `level` (0..1). `still` (reduced motion) keeps
   * the figure in place: no sway and no gestures, but the mouth and blinking still work.
   */
  step(t: number, level: number, still = false, shape?: { wide: number; fric: number }): Pose {
    // Long frames (a hidden window) are capped so nothing jumps.
    const dt = this.last === null ? 16 : Math.min(100, Math.max(0, t - this.last))
    this.last = t
    const l = Math.min(1, Math.max(0, level || 0))
    const fric = Math.min(1, Math.max(0, shape?.fric || 0))
    // Loudness sets how far the mouth opens, the viseme shape how: hiss (F, V, S) brings it towards the teeth.
    const open = l * (1 - 0.6 * fric)
    this.mouth = ease(this.mouth, open, dt, open > this.mouth ? 25 : 60)
    // The shape eases more slowly than the opening, so neighbouring sounds blend (coarticulation); silence is neutral.
    const wide = l > 0.05 ? Math.min(1, Math.max(-1, (shape?.wide || 0) + 0.4 * fric)) : 0
    this.wide = ease(this.wide, wide, dt, 70)
    this.energy = ease(this.energy, l, dt, l > this.energy ? 350 : 900)
    if (t >= this.nextBlink + BLINK_MS) this.nextBlink = t + this.gap()
    const blink = t >= this.nextBlink ? Math.sin(((t - this.nextBlink) / BLINK_MS) * Math.PI) : 0
    const pose: Pose = { ...REST, mouth: this.mouth, wide: this.wide, blink: Math.max(0, blink) }
    if (still) return pose
    const e = this.energy
    // Arms swing outward a little with energy (armL is on the image's right, so outward is anticlockwise).
    pose.armL = clampAngle(-ARM_LIFT * e + ARM_SWING * e * this.wave(0, t))
    pose.armR = clampAngle(ARM_LIFT * e + ARM_SWING * e * this.wave(1, t))
    // Legs: a subtle weight shift, both the same way.
    const shift = LEG_SWING * e * this.wave(2, t)
    pose.legL = clampAngle(shift)
    pose.legR = clampAngle(shift + LEG_SWING * 0.3 * e * this.wave(3, t))
    pose.sway = Math.sin(t / 1000 * 0.9) * 1.2 + e * 0.8 * this.wave(3, t)
    return pose
  }
}

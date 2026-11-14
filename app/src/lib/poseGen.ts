// Pose generator for the avatar window: turns the loudness of the speech into a Pose every frame.
// Pure apart from the injected clock values and RNG, so it is unit-tested (tests/poseGen.test.ts).
import { REST, type Pose } from './rigRender.ts'

// Blinks: lids drop fast and lift more slowly (human blinks close in ~60-80 ms and open in ~100-200 ms).
export const BLINK_CLOSE_MS = 65
export const BLINK_OPEN_MS = 125
export const BLINK_MS = BLINK_CLOSE_MS + BLINK_OPEN_MS
// Gap after a blink: lognormal, median 3.5 s, sigma 0.33, so ~90 % fall within 2-6 s with an occasional long stare;
// clamped so no two blinks crowd each other and no stare lasts forever.
export const BLINK_GAP_MEDIAN = 3500
export const BLINK_GAP_SIGMA = 0.33
export const BLINK_GAP_MIN = 1500
export const BLINK_GAP_MAX = 9000
/** Share of blinks followed by a second one, which starts DOUBLE_GAP_MIN..MAX ms after the first has reopened. */
export const DOUBLE_P = 0.1
export const DOUBLE_GAP_MIN = 150
export const DOUBLE_GAP_MAX = 250
/** A finished sentence blinks, unless a blink started less than this long ago (no blink storm on short sentences). */
export const BLINK_MIN_SPACING = 1000
/** Largest gesture swing at full speech energy, in degrees (arms; legs only shift the weight a little). */
export const ARM_SWING = 22
export const ARM_LIFT = 8
export const LEG_SWING = 3
export const MAX_ANGLE = 60
/** Time constant (ms) of the lips shutting for P, B, M: ~94 % shut within one 30 fps frame. */
export const CLOSE_TAU = 12

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
  /** Start of the current or next blink, the start of the previous one, and whether the next is a double's second. */
  private nextBlink: number
  private lastBlink = -Infinity
  private second = false
  /** Finished-sentence count last seen (null before the first one arrives). */
  private ended: number | null = null
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

  /** Lognormal gap (Box-Muller from two RNG draws; 1 - u keeps log away from 0). */
  private gap() {
    const z = Math.sqrt(-2 * Math.log(1 - this.rng())) * Math.cos(2 * Math.PI * this.rng())
    return Math.min(BLINK_GAP_MAX, Math.max(BLINK_GAP_MIN, BLINK_GAP_MEDIAN * Math.exp(BLINK_GAP_SIGMA * z)))
  }

  /** Schedules the blink after the one that just ended at `t`: sometimes a quick second one, else after a gap. */
  private afterBlink(t: number) {
    this.lastBlink = this.nextBlink
    this.second = !this.second && this.rng() < DOUBLE_P
    this.nextBlink = t + (this.second ? DOUBLE_GAP_MIN + this.rng() * (DOUBLE_GAP_MAX - DOUBLE_GAP_MIN) : this.gap())
  }

  /** Eye closure 0..1 at `u` ms into a blink: ease shut over BLINK_CLOSE_MS, ease open over BLINK_OPEN_MS. */
  static blinkCurve(u: number) {
    if (!(u > 0) || u >= BLINK_MS) return 0
    return u < BLINK_CLOSE_MS ? 0.5 - 0.5 * Math.cos((Math.PI * u) / BLINK_CLOSE_MS) : 0.5 + 0.5 * Math.cos((Math.PI * (u - BLINK_CLOSE_MS)) / BLINK_OPEN_MS)
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
  step(t: number, level: number, still = false, shape?: { wide: number; fric: number; close?: number; ended?: number }): Pose {
    // Long frames (a hidden window) are capped so nothing jumps.
    const dt = this.last === null ? 16 : Math.min(100, Math.max(0, t - this.last))
    this.last = t
    const l = Math.min(1, Math.max(0, level || 0))
    const fric = Math.min(1, Math.max(0, shape?.fric || 0))
    const close = Math.min(1, Math.max(0, shape?.close || 0))
    // Loudness sets how far the mouth opens, the viseme shape how: hiss (F, V, S) brings it towards the teeth, a lip
    // closure (P, B, M) shuts it. Lips snap shut (a 40 ms closure must read as one), other closing is gentler.
    const open = l * (1 - 0.6 * fric) * (1 - close)
    this.mouth = ease(this.mouth, open, dt, open > this.mouth ? 25 : close > 0.5 ? CLOSE_TAU : 60)
    // The shape eases more slowly than the opening, so neighbouring sounds blend (coarticulation); silence and closed
    // lips are neutral.
    const wide = l > 0.05 ? Math.min(1, Math.max(-1, (shape?.wide || 0) + 0.4 * fric)) * (1 - close) : 0
    this.wide = ease(this.wide, wide, dt, 70)
    this.energy = ease(this.energy, l, dt, l > this.energy ? 350 : 900)
    if (t >= this.nextBlink + BLINK_MS) this.afterBlink(t)
    // A finished sentence blinks now (a count, so frames the docked view skips lose nothing), unless the eyes are
    // already blinking, a double is pending or a blink started within BLINK_MIN_SPACING.
    const ended = shape?.ended
    if (ended !== undefined) {
      if (this.ended !== null && ended > this.ended && t < this.nextBlink && !this.second && t - this.lastBlink >= BLINK_MIN_SPACING)
        this.nextBlink = t
      this.ended = ended
    }
    const pose: Pose = { ...REST, mouth: this.mouth, wide: this.wide, blink: PoseGen.blinkCurve(t - this.nextBlink) }
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

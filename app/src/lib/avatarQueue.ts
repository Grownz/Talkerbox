// Puppet-side playback of mouth envelopes; times are epoch ms so both windows share one clock.

export interface AvatarSentence {
  /** When the sentence starts playing (epoch ms, `performance.timeOrigin + performance.now()`). */
  startMs: number
  hopMs: number
  envelope: number[]
  /** Mouth shape per hop (viseme.ts): -1 round .. 1 wide, and 0..1 teeth/fricative (closes the mouth a little). */
  wide?: number[]
  fric?: number[]
  /** Lip closure per hop (P, B, M): 1 shut, 0 not; absent from older senders. */
  close?: number[]
  /** Who sent it ('chat', 'test'); `avatar://stop` from one source leaves the others playing. */
  source?: string
  /** When the main window sent the event (epoch ms); only used to measure delivery latency. */
  sentMs?: number
}

export interface MouthSample {
  level: number
  wide: number
  fric: number
  close: number
  /** How many sentences have finished playing so far (monotonic; a stop is no finish): poseGen blinks when it grows. */
  ended: number
}

/**
 * The mouth leads the sound by this much: lips and jaw move into a sound before it is heard (visual speech leads the
 * audio by roughly 40-100 ms), and viewers accept video ahead of audio far more readily than behind it (ITU-R BT.1359:
 * up to ~125 ms audio lag goes unnoticed, only ~45 ms audio lead). 60 ms also absorbs the ~25 ms opening ease in
 * poseGen and a display frame, so the visible lead lands at about 20-40 ms. Applied when sampling, so `startMs` stays
 * the true playback start and a sentence is still dropped when its audio ends.
 */
export const LEAD_MS = 60

const lerpAt = (a: number[] | undefined, i: number, f: number) => {
  const x = a?.[i] ?? 0
  return x + ((a?.[i + 1] ?? 0) - x) * f
}

export class EnvelopeQueue {
  private items: AvatarSentence[] = []
  private ended = 0

  push(s: AvatarSentence) {
    if (s.hopMs > 0 && s.envelope.length) this.items.push(s)
  }

  /** Drops the sentences of `source`, or all of them without one. */
  clear(source?: string) {
    this.items = source === undefined ? [] : this.items.filter((s) => s.source !== source)
  }

  get size() {
    return this.items.length
  }

  /**
   * Mouth at `nowMs`, showing the sound LEAD_MS ahead; finished sentences are dropped, overlapping ones: the louder
   * one wins (with its shape).
   */
  sample(nowMs: number): MouthSample {
    const before = this.items.length
    this.items = this.items.filter((s) => nowMs < s.startMs + s.envelope.length * s.hopMs)
    this.ended += before - this.items.length
    const out: MouthSample = { level: 0, wide: 0, fric: 0, close: 0, ended: this.ended }
    for (const s of this.items) {
      const x = (nowMs + LEAD_MS - s.startMs) / s.hopMs
      if (x < 0) continue
      const i = Math.floor(x)
      const f = x - i
      const level = lerpAt(s.envelope, i, f)
      if (level > out.level) Object.assign(out, { level, wide: lerpAt(s.wide, i, f), fric: lerpAt(s.fric, i, f), close: lerpAt(s.close, i, f) })
    }
    return out
  }

  /** Mouth opening at `nowMs`. */
  level(nowMs: number): number {
    return this.sample(nowMs).level
  }
}

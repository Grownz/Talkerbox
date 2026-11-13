// Puppet-side playback of mouth envelopes; times are epoch ms so both windows share one clock.

export interface AvatarSentence {
  /** When the sentence starts playing (epoch ms, `performance.timeOrigin + performance.now()`). */
  startMs: number
  hopMs: number
  envelope: number[]
  /** Mouth shape per hop (viseme.ts): -1 round .. 1 wide, and 0..1 teeth/fricative (closes the mouth a little). */
  wide?: number[]
  fric?: number[]
  /** Who sent it ('chat', 'test'); `avatar://stop` from one source leaves the others playing. */
  source?: string
  /** When the main window sent the event (epoch ms); only used to measure delivery latency. */
  sentMs?: number
}

export interface MouthSample {
  level: number
  wide: number
  fric: number
}

const lerpAt = (a: number[] | undefined, i: number, f: number) => {
  const x = a?.[i] ?? 0
  return x + ((a?.[i + 1] ?? 0) - x) * f
}

export class EnvelopeQueue {
  private items: AvatarSentence[] = []

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

  /** Mouth at `nowMs`; finished sentences are dropped, overlapping ones: the louder one wins (with its shape). */
  sample(nowMs: number): MouthSample {
    this.items = this.items.filter((s) => nowMs < s.startMs + s.envelope.length * s.hopMs)
    const out: MouthSample = { level: 0, wide: 0, fric: 0 }
    for (const s of this.items) {
      const x = (nowMs - s.startMs) / s.hopMs
      if (x < 0) continue
      const i = Math.floor(x)
      const level = lerpAt(s.envelope, i, x - i)
      if (level > out.level) Object.assign(out, { level, wide: lerpAt(s.wide, i, x - i), fric: lerpAt(s.fric, i, x - i) })
    }
    return out
  }

  /** Mouth opening at `nowMs`. */
  level(nowMs: number): number {
    return this.sample(nowMs).level
  }
}

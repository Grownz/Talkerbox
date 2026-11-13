// Mouth envelope for the avatar: loudness of a decoded sentence, sampled every `hopMs`.

/** RMS per `hopMs` window, normalised to the sentence peak (0..1), with fast attack and slower release. */
export function envelope(samples: Float32Array, sampleRate: number, hopMs = 20): number[] {
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000))
  const rms: number[] = []
  for (let i = 0; i < samples.length; i += hop) {
    const end = Math.min(i + hop, samples.length)
    let sum = 0
    for (let j = i; j < end; j++) sum += samples[j] * samples[j]
    rms.push(Math.sqrt(sum / (end - i)))
  }
  // The floor keeps near-silence from being amplified into mouth movement.
  const peak = Math.max(0.02, ...rms)
  let s = 0
  return rms.map((r) => {
    const v = r / peak
    s += (v - s) * (v > s ? 0.7 : 0.35)
    return Math.round(s * 100) / 100
  })
}

/** Speech-like test envelope (about 4 syllables per second, short pauses between words) for `ms` milliseconds. */
export function testEnvelope(ms: number, hopMs = 20): number[] {
  return Array.from({ length: Math.max(0, Math.round(ms / hopMs)) }, (_, i) => {
    const s = (i * hopMs) / 1000
    if (s % 1.2 > 0.95) return 0 // pause between "words"
    const v = Math.max(0, Math.sin(2 * Math.PI * 4.2 * s)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * s))
    return Math.round(v * 100) / 100
  })
}

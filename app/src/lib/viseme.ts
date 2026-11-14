// Mouth shapes from the sound of a decoded sentence (Phase 6): a small acoustic classifier, no model, no dependency.
// Per hop (same frames as envelope.ts) it estimates how wide or round the lips are from where the voiced energy sits
// (front vowels like EE put energy at 1.8-3.5 kHz, round ones like OO keep almost all of it below 1 kHz) and how much
// hiss there is (F, V, S, SH: energy above 3.5 kHz), which closes the mouth towards the teeth.
// shortcut: spectral band ratios, not real formant tracking; fine for clean TTS speech, upgrade to Kokoro phoneme timing
// once the base model exports durations (see design/avatar-plan.md, Phase 6).

/** Named mouth shapes (editor preview and demo); `open` 0..1, `wide` -1 round .. 1 wide. */
export const VISEMES = {
  closed: { label: 'Closed (M, B, P)', open: 0, wide: 0 },
  open: { label: 'Open (A)', open: 1, wide: 0 },
  wide: { label: 'Wide (E, I)', open: 0.45, wide: 1 },
  round: { label: 'Round (O, U, W)', open: 0.5, wide: -1 },
  teeth: { label: 'Teeth (F, V, S)', open: 0.12, wide: 0.4 },
} as const
export type Viseme = keyof typeof VISEMES

/** In-place radix-2 FFT of `re`/`im` (length a power of two). */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(a * k)
        const s = Math.sin(a * k)
        const p = i + k
        const q = p + len / 2
        const tr = re[q] * c - im[q] * s
        const ti = re[q] * s + im[q] * c
        re[q] = re[p] - tr
        im[q] = im[p] - ti
        re[p] += tr
        im[p] += ti
      }
  }
}

const smooth = (v: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const r2 = (v: number) => Math.round(v * 100) / 100

/** Duration window of a lip closure (P, B, M); a quiet stretch outside it is a pause, not a closure. */
export const CLOSE_MIN_MS = 30
export const CLOSE_MAX_MS = 120
/** Closure frames lie this far below the sentence peak in the vowel band (dB); speech on both sides rises this far above them. */
const CLOSE_GAP_DB = -24
const CLOSE_JUMP_DB = 12
/** A closed run whose raw (unfiltered) level stays above this (dB below the raw peak) is a voiced hum (M, B). */
const MURMUR_DB = -30

const toDb = (xs: number[]) => {
  const peak = Math.max(0, ...xs)
  return xs.map((v) => (peak > 0 ? 10 * Math.log10(Math.max(v, 1e-12) / peak) : -120))
}

/**
 * Lip closures (P, B, M) per frame (1 closed, else 0) from the frame energies in the 300 Hz-8 kHz band `e`, the hiss
 * ratios and the raw frame energies: a run of CLOSE_MIN_MS..CLOSE_MAX_MS far below the vowels in that band, right
 * after speech, ended by an abrupt onset (within 2 frames), and either
 * - voiced underneath (the low hum of M, the voice bar of B: raw level above MURMUR_DB), or
 * - released with a burst: the onset frame is clearly hissier than the sound after it, but not hiss-dominated, and the
 *   sound after it is no fricative (rules out S/SH after a gap and the strongest T bursts).
 * A silent gap with a plain vowel onset (a word gap), longer pauses, sentence starts and ends, and smooth dips in
 * continuous voice never qualify.
 * shortcut: no reliable place-of-articulation cue, so some T/D/K/G closures also shut the lips briefly; add a burst
 * spectrum or F2-transition check if that shows. Runs are counted in whole hops (2-6 frames at 20 ms).
 */
function closures(e: number[], hiss: number[], raw: number[], hopMs: number): number[] {
  const n = e.length
  const out = new Array<number>(n).fill(0)
  const db = toDb(e)
  const rawDb = toDb(raw)
  for (let i = 1; i < n; ) {
    if (!(db[i] < CLOSE_GAP_DB)) {
      i++
      continue
    }
    let j = i
    while (j < n && db[j] < CLOSE_GAP_DB) j++
    const ms = (j - i) * hopMs
    const top = Math.max(...db.slice(i, j)) + CLOSE_JUMP_DB
    const after = Math.min(n - 1, j + 1)
    const onset = j < n && db[i - 1] > top && Math.max(db[j], db[after]) > top
    const murmur = rawDb.slice(i, j).every((v) => v > MURMUR_DB)
    const burst = hiss[j] > hiss[after] + 0.1 && hiss[j] < 0.75 && hiss[after] < 0.5
    if (ms >= CLOSE_MIN_MS && ms <= CLOSE_MAX_MS && onset && (murmur || burst)) out.fill(1, i, j)
    i = j
  }
  return out
}

/**
 * Mouth shape per `hopMs` frame of a sentence: `wide` -1 (round, OO) .. 0 (neutral, AH) .. 1 (wide, EE), `fric`
 * 0..1 (teeth/hiss) and `close` 1 where the lips shut for P, B, M (see `closures`), else 0. Quiet frames (below 2 %
 * of the loudest) and closed ones are neutral. Same length as `envelope()`.
 */
export function visemes(samples: Float32Array, sampleRate: number, hopMs = 20): { wide: number[]; fric: number[]; close: number[] } {
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000))
  let n = 64
  while (n < hop) n <<= 1
  const win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
  const bin = (f: number) => Math.min(n / 2, Math.max(1, Math.round((f * n) / sampleRate)))
  const top = Math.min(8000, sampleRate / 2)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const pw = new Float64Array(n / 2 + 1)
  const frames: { e: number; wide: number; fric: number; hiss: number; raw: number }[] = []
  for (let i = 0; i < samples.length; i += hop) {
    let raw = 0
    for (let k = 0; k < n; k++) {
      const x = samples[i + k] ?? 0
      raw += (x * win[k]) ** 2
      // Pre-emphasis flattens the natural -6 dB/octave tilt of voice, so formants above 1 kHz count.
      re[k] = (x - 0.95 * (samples[i + k - 1] ?? 0)) * win[k]
      im[k] = 0
    }
    fft(re, im)
    for (let k = 0; k <= n / 2; k++) pw[k] = re[k] * re[k] + im[k] * im[k]
    let voiced = 0
    let moment = 0
    for (let k = bin(300); k < bin(3500); k++) {
      voiced += pw[k]
      moment += k * pw[k]
    }
    let hissE = 0
    for (let k = bin(3500); k < bin(top); k++) hissE += pw[k]
    // First formant: strongest region of 250-1000 Hz, smoothed over ~300 Hz so single harmonics do not win.
    const half = Math.max(1, bin(150) - 1)
    let f1 = bin(250)
    let best = -1
    for (let k = bin(250); k < bin(1000); k++) {
      let s = 0
      for (let j = k - half; j <= k + half; j++) s += pw[j] ?? 0
      if (s > best) [best, f1] = [s, k]
    }
    const centroid = voiced > 0 ? ((moment / voiced) * sampleRate) / n : 0
    const f1Hz = (f1 * sampleRate) / n
    // Wide (EE): energy pulled up to 1.7 kHz and more. Round (OO): low first formant without that high energy
    // (low F1 alone also covers EE, and AH has a high F1).
    const w = smooth(centroid, 1350, 1750)
    const round = (1 - smooth(f1Hz, 350, 550)) * (1 - w)
    const hiss = hissE / (voiced + hissE || 1)
    frames.push({ e: voiced + hissE, wide: w - round, fric: smooth(hiss, 0.6, 0.85), hiss, raw })
  }
  const floor = 0.02 * Math.max(0, ...frames.map((f) => f.e))
  const close = closures(frames.map((f) => f.e), frames.map((f) => f.hiss), frames.map((f) => f.raw), hopMs)
  const quiet = (f: { e: number }, i: number) => !(f.e > floor) || close[i] > 0 // also true for all-silent input
  return {
    wide: frames.map((f, i) => (quiet(f, i) ? 0 : r2(f.wide))),
    fric: frames.map((f, i) => (quiet(f, i) ? 0 : r2(f.fric))),
    close,
  }
}

/** Speech-like test shapes to go with `testEnvelope` (cycles open, wide, round, teeth). */
export function testVisemes(frames: number): { wide: number[]; fric: number[] } {
  const seq = [0, 1, -1, 0.4, 0.6, -0.6]
  return {
    wide: Array.from({ length: frames }, (_, i) => seq[Math.floor(i / 12) % seq.length]),
    fric: Array.from({ length: frames }, (_, i) => (Math.floor(i / 12) % seq.length === 3 ? 0.8 : 0)),
  }
}

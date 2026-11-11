// Tokens-per-second figures for streamed replies. Ollama sends about one token per stream chunk,
// so chunk arrival times (ms) serve as the live estimate.

/**
 * Rolling rate over the last `windowMs`, measured from the first token so prompt processing is ignored.
 * Returns null until there is enough data.
 */
export function liveRate(stamps: number[], now: number, windowMs = 3000): number | null {
  if (stamps.length < 2) return null
  const from = Math.max(stamps[0], now - windowMs)
  const secs = (now - from) / 1000
  if (secs < 0.2) return null
  return stamps.filter((t) => t > from).length / secs
}

/** Exact rate from Ollama's final eval_count / eval_duration (ns); falls back to the chunk timestamps. */
export function finalRate(evalCount: number | null, evalDurationNs: number | null, stamps: number[]): number | null {
  if (evalCount && evalDurationNs) return evalCount / (evalDurationNs / 1e9)
  if (stamps.length < 2) return null
  const secs = (stamps[stamps.length - 1] - stamps[0]) / 1000
  return secs > 0 ? (stamps.length - 1) / secs : null
}

export const formatRate = (r: number) => `${r.toFixed(1)} tok/s`

// Timing for the decorative status animation in the sidebar (pure; tested in tests/statusAnim.test.ts).

export const MIN_DELAY_MS = 60_000
export const MAX_DELAY_MS = 600_000
/** Travel speed in px per second. */
export const SPEED = 5

/** Uniformly random wait before the next pass, in [MIN_DELAY_MS, MAX_DELAY_MS). */
export const nextDelayMs = (rng: () => number = Math.random) => MIN_DELAY_MS + rng() * (MAX_DELAY_MS - MIN_DELAY_MS)

/** Duration of one pass over `distancePx` at SPEED. */
export const passMs = (distancePx: number) => (distancePx / SPEED) * 1000

/** Indices in collapse order: lowest priority first, ties from right to left. */
export function collapseOrder(priorities: number[]): number[] {
  return priorities
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p - b.p || b.i - a.i)
    .map((o) => o.i)
}

/**
 * Svelte action for a `.fit` toolbar. Restores every `[data-fit]` button, then, while the row overflows,
 * collapses one button at a time: full label -> short label (if any) -> icon only. Inputs in the row
 * shrink to their min-width first because the row only overflows once they cannot shrink any more.
 * If the row still overflows with every button collapsed, it wraps onto more rows (`data-wrap`) instead of
 * clipping. Collapsed buttons get the full label as aria-label; their `title` stays the tooltip.
 */
export function fit(node: HTMLElement) {
  let raf = 0
  const over = () => node.scrollWidth > node.clientWidth + 1

  function stage(b: HTMLElement, s: number) {
    b.dataset.stage = String(s)
    const full = b.querySelector('.full')?.textContent?.trim()
    if (s && full) b.setAttribute('aria-label', full)
    else b.removeAttribute('aria-label')
  }

  function run() {
    raf = 0
    if (!node.offsetParent) return // hidden view: the ResizeObserver fires again once it is shown
    const buttons = [...node.querySelectorAll<HTMLElement>('[data-fit]')].filter((b) => b.closest('.fit') === node)
    delete node.dataset.wrap
    for (const b of buttons) stage(b, 0)
    if (!over()) return
    const order = collapseOrder(buttons.map((b) => Number(b.dataset.p) || 0))
    for (const s of [1, 2])
      for (const i of order) {
        if (!over()) return
        if (s === 1 && !buttons[i].querySelector('.short')) continue
        stage(buttons[i], s)
      }
    if (over()) node.dataset.wrap = ''
  }

  const schedule = () => (raf ||= requestAnimationFrame(run))
  const ro = new ResizeObserver(schedule)
  ro.observe(node)
  // Labels and buttons change with app state without the row changing size.
  const mo = new MutationObserver(schedule)
  mo.observe(node, { childList: true, subtree: true, characterData: true })
  schedule()
  return {
    destroy() {
      ro.disconnect()
      mo.disconnect()
      cancelAnimationFrame(raf)
    },
  }
}

<script lang="ts">
  // Microphone menu, opened from the mic button's context menu (right-click, Shift+F10 or the Menu key).
  import { onMount, tick } from 'svelte'
  import { api, errText, type InputDevice } from './api'
  import Icon from './Icon.svelte'

  let {
    anchor,
    value = $bindable(),
    listening,
    onClose,
  }: { anchor: HTMLElement; value: string | null; listening: boolean; onClose: () => void } = $props()

  let devices = $state<InputDevice[] | null>(null)
  let error = $state('')
  let menu: HTMLElement | undefined = $state()
  // position:fixed, placed after measuring so it never clips at the window edge.
  let pos = $state('visibility:hidden')

  // null = follow the Windows default; a saved device that is gone stays listed so the fallback is visible.
  const items = $derived.by((): { name: string | null; label: string; tip: string }[] => {
    if (!devices) return []
    const list: { name: string | null; label: string; tip: string }[] = [
      { name: null, label: 'Windows default', tip: 'Use the default recording device from the Windows sound settings' },
      ...devices.map((d) => ({
        name: d.name,
        label: d.default ? `${d.name} (default)` : d.name,
        tip: `Use ${d.name} for speech input`,
      })),
    ]
    if (value && !devices.some((d) => d.name === value))
      list.push({ name: value, label: `${value} (not found)`, tip: 'This microphone is not connected; the Windows default is used instead' })
    return list
  })

  async function place() {
    await tick()
    if (!menu) return
    const a = anchor.getBoundingClientRect()
    const maxH = innerHeight - 8
    menu.style.maxHeight = `${maxH}px`
    const { width: w, height: h } = menu.getBoundingClientRect()
    // Prefer above the button (the composer sits at the bottom of the window).
    let top = a.top - h - 4
    if (top < 4) top = Math.min(a.bottom + 4, innerHeight - h - 4)
    const left = Math.min(Math.max(4, a.right - w), innerWidth - w - 4)
    pos = `top:${Math.max(4, top)}px;left:${Math.max(4, left)}px;max-height:${maxH}px`
    await tick()
    const checked = items.findIndex((i) => i.name === value)
    focusItem(Math.max(0, checked))
  }

  function itemEls() {
    return [...(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
  }

  function focusItem(i: number) {
    const els = itemEls()
    els[(i + els.length) % els.length]?.focus()
  }

  function close(refocus = true) {
    onClose()
    if (refocus) anchor.focus()
  }

  function choose(name: string | null) {
    value = name
    close()
  }

  function onKey(e: KeyboardEvent) {
    const els = itemEls()
    const i = els.indexOf(document.activeElement as HTMLElement)
    const moves: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: els.length - 1 }
    if (e.key in moves) {
      e.preventDefault()
      focusItem(moves[e.key])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      close()
    }
  }

  function onWindowPointer(e: PointerEvent) {
    if (menu && !menu.contains(e.target as Node)) close(false)
  }

  onMount(() => {
    api.sttDevices().then(
      (d) => (devices = d),
      (e) => ((error = `Could not list microphones: ${errText(e)}`), (devices = [])),
    )
  })

  $effect(() => {
    void items.length
    void error
    place()
  })
</script>

<svelte:window onpointerdown={onWindowPointer} onresize={() => close(false)} onblur={() => close(false)} />

<div bind:this={menu} class="dev-menu" style={pos} role="menu" tabindex="-1" aria-label="Microphone for speech input" onkeydown={onKey}>
  <div class="dm-head" role="presentation">Microphone</div>
  {#if !devices}
    <div class="dm-note" role="presentation">Looking for microphones…</div>
  {:else}
    {#each items as it (it.name ?? '')}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={it.name === value}
        tabindex="-1"
        title={listening ? `${it.tip}; applies from the next listening session` : it.tip}
        onclick={() => choose(it.name)}
        ><span class="dm-check"><Icon name="check" /></span><span class="dm-l">{it.label}</span></button
      >
    {/each}
  {/if}
  {#if error}<div class="dm-note err" role="presentation">{error}</div>{/if}
  {#if listening}<div class="dm-note" role="presentation">A new choice applies from the next listening session.</div>{/if}
</div>

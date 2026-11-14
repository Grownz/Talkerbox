<script lang="ts">
  // The avatar: plays mouth envelopes and shapes from the main window on its own rAF clock; poseGen.ts turns them
  // into mouth, blink, sway and gestures. Runs in the avatar window (with its own title bar) and, `docked`, in the
  // main window's sidebar, where `listen` is the in-page bus (avatar.svelte.ts) instead of Tauri events.
  import { listen as tauriListen } from '@tauri-apps/api/event'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { onMount } from 'svelte'
  import { api, errText } from './api'
  import { puppetClose, type AvatarOptions } from './avatar.svelte'
  import { EnvelopeQueue, type AvatarSentence } from './avatarQueue'
  import { DemoPuppet, type Puppet } from './demoPuppet'
  import Icon from './Icon.svelte'
  import { PoseGen } from './poseGen'
  import { RigPuppet } from './rigPuppet'

  type Listen = <T>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>
  let {
    docked = false,
    listen = tauriListen,
    ready = () => void api.puppetReady(),
  }: { docked?: boolean; listen?: Listen; ready?: () => void } = $props()

  let opts = $state<AvatarOptions>({ bg: 'normal', opacity: 100, character: null, rev: 0 })
  let host: HTMLDivElement

  // Transparent mode: the window itself is transparent, so html/body must not paint the theme background.
  $effect(() => {
    if (docked) return
    const clear = opts.bg === 'transparent'
    document.documentElement.style.background = clear ? 'transparent' : ''
    document.body.style.background = clear ? 'transparent' : ''
  })

  // Title bar: always shown on an opaque window; with a see-through background it fades out and comes back while
  // the pointer is over the window (or a bar button has keyboard focus).
  const autoHide = $derived(opts.bg === 'transparent' && opts.opacity < 100)
  let hover = $state(false)
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  const enter = () => {
    clearTimeout(hideTimer)
    hover = true
  }
  const leave = () => {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => (hover = false), 600)
  }
  const drag = (e: MouseEvent) => {
    if (e.button === 0 && !(e.target as Element).closest('button')) void getCurrentWindow().startDragging()
  }
  // Errors cannot be shown in this window; the console is the only place for them.
  const report = (what: string) => (e: unknown) => console.warn(`${what} failed: ${errText(e)}`)

  onMount(() => {
    let puppet: Puppet = new DemoPuppet(host)
    let shown = 'demo'
    let imageUrl = ''
    let loading = 0
    // Swaps to the saved character, or back to the demo figure when there is none or it cannot be loaded.
    async function show(id: string | null) {
      const token = ++loading
      let next: Puppet | null = null
      let url = ''
      let fill: ImageBitmap | null = null
      if (id) {
        try {
          const rig = await api.avatarLoad(id)
          url = URL.createObjectURL(await api.avatarImage(rig))
          const img = new Image()
          img.src = url
          await img.decode()
          // The AI fill under moved parts; without it (or if it cannot be read) the classic fill is used.
          fill = rig.fill?.mode === 'ai' && rig.fill.image ? await api.avatarFill(id).then(createImageBitmap, () => null) : null
          if (token === loading) next = new RigPuppet(host, rig, img, fill)
        } catch (e) {
          console.warn(`Avatar character '${id}' could not be shown; using the demo figure`, e)
        }
      }
      // Superseded (a newer call, or unmounted) or failed: free the image (up to 20 MB) and the fill now.
      if (token !== loading || !next) {
        URL.revokeObjectURL(url)
        fill?.close()
        if (token !== loading) return
      }
      puppet.destroy?.()
      puppet = next ?? new DemoPuppet(host)
      URL.revokeObjectURL(imageUrl)
      imageUrl = next ? url : ''
    }

    const queue = new EnvelopeQueue()
    const now = () => performance.timeOrigin + performance.now()
    const still = matchMedia('(prefers-reduced-motion: reduce)')
    const gen = new PoseGen(Math.random, performance.now())
    let raf = 0
    let last = -Infinity
    function frame(t: number) {
      const m = queue.sample(now())
      // Docked, the figure shares the main window's thread with the chat: about 30 fps while it talks, 15 when it
      // only blinks and sways (barely visible at sidebar size). The window has its own process and runs at full rate.
      if (!docked || t - last >= (m.level > 0.02 ? 33 : 66)) {
        last = t
        // Reduced motion: no sway and no gestures; the mouth and blinking still follow.
        puppet.frame(gen.step(t, m.level, still.matches, m), still.matches ? 0 : t)
      }
      raf = requestAnimationFrame(frame)
    }
    // No drawing while the window is hidden or minimised, or the figure has no room (docked in a short sidebar); the
    // envelope queue keeps its own clock. WebView2 does not always report a minimised window as hidden (wry does not
    // hide the webview), so the Rust side tells us too (for the main window through `app://minimized`).
    let minimized = false
    const run = () => {
      cancelAnimationFrame(raf)
      raf = document.hidden || minimized || host.clientWidth < 4 || host.clientHeight < 4 ? 0 : requestAnimationFrame(frame)
    }
    document.addEventListener('visibilitychange', run)
    const ro = new ResizeObserver(run)
    ro.observe(host)
    run()
    const off = [
      listen<AvatarSentence>('avatar://sentence', (e) => {
        // Delivery latency between the windows; the envelope itself is timed by startMs, not by arrival.
        if (e.payload.sentMs) host.dataset.latencyMs = (now() - e.payload.sentMs).toFixed(1)
        queue.push(e.payload)
      }),
      listen<{ source?: string } | null>('avatar://stop', (e) => queue.clear(e.payload?.source)),
      listen<boolean>('avatar://minimized', (e) => {
        minimized = e.payload
        run()
      }),
      listen<AvatarOptions>('avatar://options', (e) => {
        opts = e.payload
        // A saved edit (new rev) reloads the same character.
        const key = opts.character ? `${opts.character}#${opts.rev ?? 0}` : 'demo'
        if (key !== shown) {
          shown = key
          void show(opts.character ?? null)
        }
      }),
      // A reloaded main window asks whether the avatar window is open.
      listen('avatar://ping', ready),
    ]
    // Ask the main window for options once the listeners are registered.
    void Promise.all(off).then(ready)
    return () => {
      loading++ // a load still in flight frees its result instead of showing it
      cancelAnimationFrame(raf)
      clearTimeout(hideTimer)
      ro.disconnect()
      document.removeEventListener('visibilitychange', run)
      puppet.destroy?.()
      URL.revokeObjectURL(imageUrl)
      off.forEach((p) => void p.then((u) => u()))
    }
  })
</script>

<div
  class="stage"
  class:docked
  class:barred={!docked && !autoHide}
  role="presentation"
  onmouseenter={enter}
  onmouseleave={leave}
  style:background={docked
    ? 'transparent'
    : opts.bg === 'green'
      ? '#00ff00'
      : opts.bg === 'transparent'
        ? `color-mix(in srgb, var(--win-bg) ${opts.opacity}%, transparent)`
        : 'var(--win-bg)'}
>
  {#if !docked}
    <!-- svelte-ignore a11y_no_static_element_interactions (dragging the window is mouse-only, like a native title bar) -->
    <header class="tb" class:auto={autoHide} class:show={hover} onmousedown={drag}>
      <span class="tt"><Icon name="figure" />Avatar</span>
      <button type="button" class="tbb" title="Dock into the main window" aria-label="Dock into the main window" onclick={() => api.puppetDock().catch(report('Docking'))}
        ><Icon name="dock" /></button
      >
      <button type="button" class="tbb" title="Minimize" aria-label="Minimize" onclick={() => getCurrentWindow().minimize().catch(report('Minimizing'))}
        ><Icon name="minus" /></button
      >
      <button type="button" class="tbb close" title="Close the avatar window" aria-label="Close" onclick={() => puppetClose().catch(report('Closing'))}
        ><Icon name="x" /></button
      >
    </header>
  {/if}
  <div class="figure" bind:this={host} style:opacity={docked || opts.bg === 'transparent' ? 1 : opts.opacity / 100}></div>
</div>

<style>
  .stage {
    position: relative;
    height: 100%;
    padding: 8px;
  }
  .stage.barred {
    padding-top: 40px;
  }
  .stage.docked {
    padding: 0;
  }
  .figure {
    height: 100%;
  }
  .tb {
    position: absolute;
    inset: 0 0 auto;
    z-index: 1;
    display: flex;
    align-items: center;
    height: 32px;
    padding-left: 10px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    color: var(--text-2);
    font-size: var(--fs-sm);
    user-select: none;
    transition: opacity 0.2s var(--ease);
  }
  /* Over a see-through background: hidden until hovered, then slightly translucent so the figure shows through. */
  .tb.auto {
    opacity: 0;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
  }
  .tb.auto.show,
  .tb.auto:focus-within {
    opacity: 1;
  }
  .tt {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    white-space: nowrap;
    font-weight: 600;
  }
  .tt :global(.i) {
    width: 16px;
    height: 16px;
    flex: none;
  }
  .tbb {
    width: 40px;
    min-width: 0;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text-2);
  }
  .tbb :global(.i) {
    width: 16px;
    height: 16px;
  }
  .tbb:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .tbb.close:hover {
    background: #c42b1c;
    color: #fff;
  }
</style>

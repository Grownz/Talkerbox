<script lang="ts">
  // Avatar window: plays mouth envelopes and shapes from the main window on its own rAF clock; poseGen.ts turns them
  // into mouth, blink, sway and gestures.
  import { emitTo, listen } from '@tauri-apps/api/event'
  import { onMount } from 'svelte'
  import { api } from './api'
  import type { AvatarOptions } from './avatar.svelte'
  import { EnvelopeQueue, type AvatarSentence } from './avatarQueue'
  import { DemoPuppet, type Puppet } from './demoPuppet'
  import { PoseGen } from './poseGen'
  import { RigPuppet } from './rigPuppet'

  let opts = $state<AvatarOptions>({ bg: 'normal', opacity: 100, character: null, rev: 0 })
  let host: HTMLDivElement

  // Transparent mode: the window itself is transparent, so html/body must not paint the theme background.
  $effect(() => {
    const clear = opts.bg === 'transparent'
    document.documentElement.style.background = clear ? 'transparent' : ''
    document.body.style.background = clear ? 'transparent' : ''
  })

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
      if (id) {
        try {
          const rig = await api.avatarLoad(id)
          url = URL.createObjectURL(await api.avatarImage(rig))
          const img = new Image()
          img.src = url
          await img.decode()
          if (token === loading) next = new RigPuppet(host, rig, img)
        } catch (e) {
          console.warn(`Avatar character '${id}' could not be shown; using the demo figure`, e)
        }
      }
      if (token !== loading) return URL.revokeObjectURL(url)
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
    function frame(t: number) {
      const m = queue.sample(now())
      // Reduced motion: no sway and no gestures; the mouth and blinking still follow.
      puppet.frame(gen.step(t, m.level, still.matches, m), still.matches ? 0 : t)
      raf = requestAnimationFrame(frame)
    }
    // No drawing while the window is hidden or minimised; the envelope queue keeps its own clock. WebView2 does not
    // always report a minimised window as hidden (wry does not hide the webview), so the Rust side tells us too.
    let minimized = false
    const run = () => {
      cancelAnimationFrame(raf)
      raf = document.hidden || minimized ? 0 : requestAnimationFrame(frame)
    }
    document.addEventListener('visibilitychange', run)
    run()
    const ready = () => emitTo('main', 'avatar://ready')
    const off = [
      listen<AvatarSentence>('avatar://sentence', (e) => {
        // Delivery latency between the windows; the envelope itself is timed by startMs, not by arrival.
        if (e.payload.sentMs) document.body.dataset.latencyMs = (now() - e.payload.sentMs).toFixed(1)
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
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', run)
      puppet.destroy?.()
      URL.revokeObjectURL(imageUrl)
      off.forEach((p) => void p.then((u) => u()))
    }
  })
</script>

<div
  class="stage"
  style:background={opts.bg === 'green'
    ? '#00ff00'
    : opts.bg === 'transparent'
      ? `color-mix(in srgb, var(--win-bg) ${opts.opacity}%, transparent)`
      : 'var(--win-bg)'}
>
  <div class="figure" bind:this={host} style:opacity={opts.bg === 'transparent' ? 1 : opts.opacity / 100}></div>
</div>

<style>
  .stage {
    height: 100%;
    padding: 8px;
  }
  .figure {
    height: 100%;
  }
</style>

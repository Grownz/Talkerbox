<script lang="ts">
  // Read-only view of the captured `ollama serve` output. Deliberately has no input of any kind.
  import { listen } from '@tauri-apps/api/event'
  import { onMount, tick } from 'svelte'
  import { api, errText, type LogLine } from './api'

  let { running, startedByApp, onClose }: { running: boolean; startedByApp: boolean; onClose: () => void } = $props()

  const MAX = 5000
  let buf: string[] = []
  let lastSeq = 0
  let text = $state('')
  let follow = $state(true)
  let error = $state('')
  let pre: HTMLElement | undefined = $state()
  let closeBtn: HTMLButtonElement | undefined = $state()
  let frame = 0

  function add(l: LogLine) {
    if (l.seq <= lastSeq) return
    lastSeq = l.seq
    buf.push(l.line)
    if (buf.length > MAX) buf.splice(0, buf.length - MAX)
    // Render at most once per animation frame, however fast lines arrive.
    frame ||= requestAnimationFrame(render)
  }

  async function render() {
    frame = 0
    text = buf.join('\n')
    if (follow) {
      await tick()
      pre?.scrollTo({ top: pre.scrollHeight })
    }
  }

  function onScroll() {
    if (!pre) return
    follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8
  }

  function jumpToEnd() {
    follow = true
    pre?.scrollTo({ top: pre.scrollHeight })
  }

  async function clear() {
    await api.ollamaLogClear().catch((e) => (error = errText(e)))
    buf = []
    text = ''
  }

  onMount(() => {
    closeBtn?.focus()
    let unlisten: (() => void) | undefined
    let pending: LogLine[] | null = []
    ;(async () => {
      try {
        // Listen first, then fetch the snapshot; queued live lines are applied after it (seq dedupes overlap).
        unlisten = await listen<LogLine>('ollama-log', (e) => (pending ? pending.push(e.payload) : add(e.payload)))
        for (const l of await api.ollamaLog()) add(l)
        for (const l of pending ?? []) add(l)
        pending = null
      } catch (e) {
        error = errText(e)
      }
    })()
    return () => {
      unlisten?.()
      cancelAnimationFrame(frame)
    }
  })
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} />

<div class="modal-backdrop">
  <div class="modal terminal" role="dialog" aria-modal="true" aria-labelledby="term-title">
    <div class="section-head">
      <h2 id="term-title">Ollama server output</h2>
      <div class="row">
        {#if !follow}<button class="ghost" title="Scroll to the newest output and follow it again" onclick={jumpToEnd}>Auto-scroll paused: jump to end</button>{/if}
        <button class="ghost" title="Empty the captured output (the server keeps running)" onclick={clear}>Clear</button>
        <button class="ghost" title="Close this view (Escape); output keeps being captured" bind:this={closeBtn} onclick={onClose}>Close</button>
      </div>
    </div>
    {#if running && !startedByApp}
      <p class="muted">Ollama was started outside Talkerbox, so its output cannot be captured here.</p>
    {:else if !running && !text}
      <p class="muted">Ollama is not running. Start it with the status LED; its output will appear here.</p>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <!-- tabindex so the log can be scrolled with the keyboard; it is not editable. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <pre class="term-output" bind:this={pre} onscroll={onScroll} tabindex="0" aria-label="Ollama server output">{text}</pre>
  </div>
</div>

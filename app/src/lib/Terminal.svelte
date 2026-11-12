<script lang="ts">
  // Read-only view of the captured `ollama serve` output. Deliberately has no input of any kind.
  import { listen } from '@tauri-apps/api/event'
  import { onMount, tick } from 'svelte'
  import { api, errText, type LogLine } from './api'
  import Btn from './Btn.svelte'
  import Icon from './Icon.svelte'

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

<div class="scrim">
  <div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="term-title">
    <div class="dlg-head">
      <span class="ico acc"><Icon name="terminal" /></span>
      <h2 id="term-title">Ollama server output <span class="badge outline">read-only</span></h2>
      <Btn icon="eraser" label="Clear" title="Empty the captured output (the server keeps running)" onclick={clear} />
      <button type="button" class="icon-only ghost" title="Close this view (Escape); output keeps being captured" aria-label="Close" bind:this={closeBtn} onclick={onClose}><Icon name="x" /></button>
    </div>
    <div class="dlg-body">
      {#if running && !startedByApp}
        <p>Ollama was started outside Talkerbox, so its output cannot be captured here.</p>
      {:else if !running && !text}
        <p>Ollama is not running. Start it with the status light; its output will appear here.</p>
      {/if}
      {#if error}<p class="err-text" role="alert">{error}</p>{/if}
      <div class="term-wrap">
        <!-- tabindex so the log can be scrolled with the keyboard; it is not editable. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre class="term" bind:this={pre} onscroll={onScroll} tabindex="0" aria-label="Ollama server output">{text}</pre>
        {#if !follow}
          <Btn icon="arrow-down" label="Auto-scroll paused: jump to end" class="primary sm newlines" title="Scroll to the newest output and follow it again" onclick={jumpToEnd} />
        {/if}
      </div>
    </div>
  </div>
</div>

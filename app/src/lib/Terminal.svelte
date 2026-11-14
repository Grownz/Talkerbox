<script lang="ts">
  // Read-only view of the captured `ollama serve` output. The search box and toggles only filter and format what is
  // shown here; nothing is ever sent to the Ollama server (no stdin, no requests).
  import { listen } from '@tauri-apps/api/event'
  import { onMount, untrack } from 'svelte'
  import { api, errText, type LogLine } from './api'
  import Btn from './Btn.svelte'
  import Icon from './Icon.svelte'
  import { LABEL, PRESETS, TOPICS, classify, parseLine, segments, topicsOn, viewRows, type Group, type Parsed, type Topic } from './ollamaLog'

  let { running, startedByApp, onClose }: { running: boolean; startedByApp: boolean; onClose: () => void } = $props()

  type Row = Parsed & { id: number; raw: string; topic: Topic }
  const TOPIC_LABEL = Object.fromEntries(TOPICS.map((x) => [x.t, x.label])) as Record<Topic, string>
  const MAX = 5000
  const GROUPS: { g: Group; label: string }[] = [
    { g: 'error', label: 'Error' },
    { g: 'warn', label: 'Warn' },
    { g: 'info', label: 'Info' },
    { g: 'other', label: 'Other' },
  ]
  let buf: Row[] = []
  let lastSeq = 0
  let prevTopic: Topic | null = null
  let lines: Row[] = $state.raw([])
  let on: Record<Group, boolean> = $state({ error: true, warn: true, info: true, other: true })
  let raw = $state(false)
  let search = $state('')
  let query = $state('')
  // Fresh each time the dialog opens; nothing is persisted.
  let topics: Record<Topic, boolean> = $state(topicsOn(PRESETS.Overview))
  let view = $derived(viewRows(lines, on, topics, query))
  let shown = $derived(view.shown)
  let filtered = $derived(shown.length !== lines.length)
  let counts = $derived.by(() => {
    const c: Partial<Record<Topic, number>> = {}
    for (const l of lines) c[l.topic] = (c[l.topic] ?? 0) + 1
    return c
  })
  let follow = $state(true)
  let error = $state('')
  let copyMsg = $state('')
  let log: HTMLElement | undefined = $state()
  let closeBtn: HTMLButtonElement | undefined = $state()
  let frame = 0
  let debounce: ReturnType<typeof setTimeout> | undefined

  function add(l: LogLine) {
    if (l.seq <= lastSeq) return
    lastSeq = l.seq
    prevTopic = classify(l.line, prevTopic)
    buf.push({ id: l.seq, raw: l.line, topic: prevTopic, ...parseLine(l.line) }) // parsed once, when the line arrives
    if (buf.length > MAX) buf.splice(0, buf.length - MAX)
    // Render at most once per animation frame, however fast lines arrive.
    frame ||= requestAnimationFrame(render)
  }

  function render() {
    frame = 0
    lines = buf.slice()
  }

  // Effects run after the DOM update, so the new rows are already there to scroll to.
  $effect(() => {
    void shown
    if (untrack(() => follow)) log?.scrollTo({ top: log.scrollHeight })
  })

  function onScroll() {
    if (!log) return
    follow = log.scrollTop + log.clientHeight >= log.scrollHeight - 8
  }

  function jumpToEnd() {
    follow = true
    log?.scrollTo({ top: log.scrollHeight })
  }

  function onSearch() {
    clearTimeout(debounce)
    debounce = setTimeout(() => (query = search), 150)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown.map((l) => l.raw).join('\n'))
      copyMsg = `Copied ${shown.length} ${shown.length === 1 ? 'line' : 'lines'}`
    } catch (e) {
      copyMsg = `Copy failed: ${errText(e)}`
    }
  }

  async function clear() {
    await api.ollamaLogClear().catch((e) => (error = errText(e)))
    buf = []
    lines = []
    prevTopic = null
  }

  function isPreset(list: Topic[]) {
    return TOPICS.every(({ t }) => topics[t] === list.includes(t))
  }

  onMount(() => {
    closeBtn?.focus()
    let unlisten: (() => void) | undefined
    let alive = true
    let pending: LogLine[] | null = []
    ;(async () => {
      try {
        // Listen first, then fetch the snapshot; queued live lines are applied after it (seq dedupes overlap).
        unlisten = await listen<LogLine>('ollama-log', (e) => (pending ? pending.push(e.payload) : add(e.payload)))
        if (!alive) return unlisten() // closed before the listener was attached
        for (const l of await api.ollamaLog()) add(l)
        for (const l of pending ?? []) add(l)
        pending = null
      } catch (e) {
        error = errText(e)
      }
    })()
    return () => {
      alive = false
      unlisten?.()
      cancelAnimationFrame(frame)
      clearTimeout(debounce)
    }
  })
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} />

<div class="scrim">
  <div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="term-title">
    <div class="dlg-head">
      <span class="ico acc"><Icon name="terminal" /></span>
      <h2 id="term-title">Ollama server output <span class="badge outline">read-only</span></h2>
      <Btn icon="copy" label="Copy" title="Copy the lines shown below (original text) to the clipboard" onclick={copy} />
      <Btn icon="eraser" label="Clear" title="Empty the captured output (the server keeps running)" onclick={clear} />
      <button type="button" class="icon-only ghost" title="Close this view (Escape); output keeps being captured" aria-label="Close" bind:this={closeBtn} onclick={onClose}><Icon name="x" /></button>
    </div>
    <div class="dlg-body">
      {#if running && !startedByApp}
        <p>Ollama was started outside Talkerbox, so its output cannot be captured here.</p>
      {:else if !running && !lines.length}
        <p>Ollama is not running. Start it with the status light; its output will appear here.</p>
      {/if}
      {#if error}<p class="err-text" role="alert">{error}</p>{/if}
      <div class="term-bar" role="group" aria-label="View options (only change what is shown)">
        {#each GROUPS as { g, label } (g)}
          <button type="button" class="sm" aria-pressed={on[g]} title={g === 'other' ? 'Lines without a level: llama.cpp output, DEBUG, access log' : `Lines with level ${label.toUpperCase()}`} onclick={() => (on[g] = !on[g])}
            >{#if on[g]}<Icon name="check" />{/if}{label}</button
          >
        {/each}
        <input type="search" class="term-search" aria-label="Search the output" placeholder="Search" spellcheck="false" bind:value={search} oninput={onSearch} />
        <span class="term-count">{filtered ? `${shown.length} of ${lines.length} lines` : `${lines.length} lines`}</span>
        <button type="button" class="sm" aria-pressed={raw} title="Show the original lines unchanged (no labels, full timestamps)" onclick={() => (raw = !raw)}>Raw</button>
        <span class="term-count" role="status">{copyMsg}</span>
      </div>
      <div class="term-bar" role="group" aria-label="Topics (only change what is shown)">
        <span class="term-count">Topics</span>
        {#each TOPICS as { t, label, title } (t)}
          <button type="button" class="sm" aria-pressed={topics[t]} {title} onclick={() => (topics[t] = !topics[t])}
            >{#if topics[t]}<Icon name="check" />{/if}{label} <span class="term-n">{counts[t] ?? 0}</span></button
          >
        {/each}
        <span class="term-presets">
          {#each Object.entries(PRESETS) as [name, list] (name)}
            <button type="button" class="sm ghost" aria-pressed={isPreset(list)} title={`Show these topics: ${list.map((t) => TOPIC_LABEL[t]).join(', ')}`} onclick={() => (topics = topicsOn(list))}>{name}</button>
          {/each}
        </span>
      </div>
      <div class="term-wrap">
        <!-- tabindex so the log can be scrolled with the keyboard; it is not editable. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="term" role="region" bind:this={log} onscroll={onScroll} tabindex="0" aria-label="Ollama server output">
          {#each view.rows as l ('key' in l ? l.key : l.id)}
            {#if 'key' in l}
              {@const t = l.topic}
              <button type="button" class="hid" title={`Show the ${TOPIC_LABEL[t]} topic`} onclick={() => (topics[t] = true)}>{l.hidden} {l.hidden === 1 ? 'line' : 'lines'} hidden: {TOPIC_LABEL[t]}</button>
            {:else}
            <div class={['ln', !raw && l.level]}>{#if !raw}{#if l.level}<span class="lv">{LABEL[l.level]}</span>{/if}{#if l.time}<span class="ts" title={l.timeFull}>{l.time}</span>{/if}{/if}{#each segments(raw ? l.raw : l.text, query) as s, i (i)}{#if s.hit}<mark>{s.t}</mark>{:else}{s.t}{/if}{/each}</div>
            {/if}
          {/each}
        </div>
        {#if !follow}
          <Btn icon="arrow-down" label="Auto-scroll paused: jump to end" class="primary sm newlines" title="Scroll to the newest output and follow it again" onclick={jumpToEnd} />
        {/if}
      </div>
    </div>
  </div>
</div>

<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { renderReply } from './markdown'

  // An assistant reply: Markdown when detected (see markdown.ts), plain text otherwise. While streaming it re-renders
  // at most every THROTTLE_MS (longer when rendering itself is slow), and once more when the reply is complete.
  // `thinking`: the model's reasoning before the answer (plain text, never Markdown); `thinkStart`/`thinkEnd` are
  // performance.now() stamps of its first thinking and first answer token.
  let {
    text,
    thinking = '',
    thinkStart,
    thinkEnd,
    streaming,
    onrender,
  }: { text: string; thinking?: string; thinkStart?: number; thinkEnd?: number; streaming: boolean; onrender?: () => void } =
    $props()

  const THROTTLE_MS = 90
  let out = $state({ html: '', markdown: false, thinking: '' })
  let latest = ''
  let latestThinking = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let nextAt = 0
  let thinkBox: HTMLElement | undefined = $state()

  function draw() {
    timer = undefined
    const t = performance.now()
    out = { ...renderReply(latest), thinking: latestThinking }
    nextAt = t + THROTTLE_MS
    tick().then(() => {
      // Parsing plus the DOM update may take at most about a quarter of the time, so typing stays responsive.
      const cost = performance.now() - t
      nextAt = performance.now() + Math.max(THROTTLE_MS - cost, 3 * cost)
      if (thinkingNow && thinkBox) thinkBox.scrollTop = thinkBox.scrollHeight
      onrender?.()
    })
  }

  // Reads only the props; `out` is written but never read here, so this cannot loop.
  $effect(() => {
    latest = text
    latestThinking = thinking
    if (!streaming) {
      clearTimeout(timer)
      draw()
    } else timer ??= setTimeout(draw, Math.max(0, nextAt - performance.now()))
  })
  onDestroy(() => clearTimeout(timer))

  // Still reasoning: no answer token yet.
  const thinkingNow = $derived(streaming && thinkStart !== undefined && thinkEnd === undefined)
  // Seconds counter while thinking: ticks once per second; reads only `thinkingNow`, writes only `now`.
  let now = $state(0)
  $effect(() => {
    if (!thinkingNow) return
    now = performance.now()
    const t = setInterval(() => (now = performance.now()), 1000)
    return () => clearInterval(t)
  })
  const secs = $derived(
    thinkStart === undefined ? 0 : Math.max(0, Math.round(((thinkEnd ?? (thinkingNow ? now : thinkStart)) - thinkStart) / 1000)),
  )
  // null until the user toggles: open while thinking, collapsed once the answer starts.
  let userOpen = $state<boolean | null>(null)
  const open = $derived(userOpen ?? thinkingNow)

  async function onclick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.md-copy')
    const code = btn?.parentElement?.querySelector('code')?.textContent
    if (!btn || code == null) return
    try {
      await navigator.clipboard.writeText(code)
      btn.textContent = 'Copied'
    } catch {
      btn.textContent = 'Copy failed'
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1500)
  }
</script>

{#if thinkStart !== undefined}
  <!-- The thinking text is plain escaped text: it is never rendered as Markdown, spoken or sent back to the model. -->
  <div class="think" class:live={thinkingNow}>
    <button
      type="button"
      class="think-head"
      aria-expanded={open}
      title={open ? 'Hide what the model thought before answering' : 'Show what the model thought before answering (not read aloud)'}
      onclick={() => (userOpen = !open)}
      ><span class="chev" aria-hidden="true">▸</span><span
        >{#if thinkingNow}Thinking<span class="dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span
          >{:else}Thought for{/if} <span class="secs">{secs} s</span></span
      ></button
    >
    {#if open}<div class="think-text" bind:this={thinkBox}>{out.thinking}</div>{/if}
  </div>
{/if}
{#if text || thinkStart === undefined}
  <!-- The click handler only serves the code blocks' copy buttons (real buttons, so keyboard users reach them). The
     HTML is escaped text or markdown.ts output (raw HTML disabled). One line: the plain view keeps whitespace. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="bubble" class:md={out.markdown} class:streaming {onclick}>{@html out.html}{#if streaming && !out.markdown}<span class="caret" aria-hidden="true"></span>{/if}</div>
{/if}

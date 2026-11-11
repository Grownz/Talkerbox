<script lang="ts">
  // Accessible custom listbox: native <select> cannot show images and Windows has no flag emoji glyphs.
  // Flags: flag-icons (MIT), bundled by Vite (small files are inlined as data: URIs, so CSP stays 'self' + data:).
  import br from 'flag-icons/flags/4x3/br.svg'
  import cn from 'flag-icons/flags/4x3/cn.svg'
  import es from 'flag-icons/flags/4x3/es.svg'
  import fr from 'flag-icons/flags/4x3/fr.svg'
  import gb from 'flag-icons/flags/4x3/gb.svg'
  import inFlag from 'flag-icons/flags/4x3/in.svg'
  import it from 'flag-icons/flags/4x3/it.svg'
  import jp from 'flag-icons/flags/4x3/jp.svg'
  import us from 'flag-icons/flags/4x3/us.svg'
  import { groupVoices, voiceInfo } from './voices'

  const FLAGS: Record<string, string> = { br, cn, es, fr, gb, in: inFlag, it, jp, us }

  let { voices, value = $bindable() }: { voices: string[]; value: string | null } = $props()

  const uid = `voice-${Math.random().toString(36).slice(2)}`
  const groups = $derived(groupVoices(voices))
  const flat = $derived(groups.flatMap((g) => g.voices))
  const current = $derived(value ? voiceInfo(value) : null)

  let open = $state(false)
  let active = $state(0)
  let button: HTMLButtonElement | undefined = $state()
  let list: HTMLElement | undefined = $state()
  let root: HTMLElement | undefined = $state()

  function show() {
    open = true
    active = Math.max(0, flat.findIndex((v) => v.id === value))
    queueMicrotask(() => {
      list?.focus()
      scrollActive()
    })
  }

  function close(refocus = true) {
    open = false
    if (refocus) button?.focus()
  }

  function choose(id: string) {
    value = id
    close()
  }

  function scrollActive() {
    list?.querySelector(`#${uid}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }

  function onButtonKey(e: KeyboardEvent) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault()
      show()
    }
  }

  function onListKey(e: KeyboardEvent) {
    const last = flat.length - 1
    const moves: Record<string, number> = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: last, PageDown: active + 8, PageUp: active - 8 }
    if (e.key in moves) {
      e.preventDefault()
      active = Math.min(last, Math.max(0, moves[e.key]))
      scrollActive()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (flat[active]) choose(flat[active].id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  function onWindowPointer(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) close(false)
  }
</script>

<svelte:window onpointerdown={onWindowPointer} />

{#snippet flag(country: string | null)}
  {#if country && FLAGS[country]}
    <img class="flag" src={FLAGS[country]} alt="" />
  {:else}
    <svg class="flag globe" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M2 12h20M12 2c3 3 3 17 0 20M12 2c-3 3-3 17 0 20" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  {/if}
{/snippet}

<div class="voice-picker" bind:this={root}>
  <button
    bind:this={button}
    type="button"
    class="ghost voice-button"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={`Voice: ${current ? `${current.label}, ${current.language}` : 'none'}`}
    title={value ?? ''}
    disabled={!voices.length}
    onclick={() => (open ? close() : show())}
    onkeydown={onButtonKey}
  >
    {@render flag(current?.country ?? null)}
    <span>{current?.label ?? 'Choose voice'}</span>
    <span aria-hidden="true">▾</span>
  </button>
  {#if open}
    <ul
      bind:this={list}
      class="voice-list"
      role="listbox"
      tabindex="-1"
      aria-label="Voice"
      aria-activedescendant={`${uid}-${active}`}
      onkeydown={onListKey}
    >
      {#each groups as g (g.language)}
        <li role="presentation">
          <ul role="group" aria-label={g.language}>
            <li role="presentation" class="voice-group">{@render flag(g.country)} {g.language}</li>
            {#each g.voices as v (v.id)}
              {@const i = flat.indexOf(v)}
              <!-- svelte-ignore a11y_click_events_have_key_events (keyboard is handled on the listbox via aria-activedescendant) -->
              <li
                id={`${uid}-${i}`}
                role="option"
                aria-selected={v.id === value}
                class:active={i === active}
                title={v.id}
                onclick={() => choose(v.id)}
                onpointermove={() => (active = i)}
              >
                {@render flag(v.country)}
                {v.label}
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}
</div>

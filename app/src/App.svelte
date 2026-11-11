<script lang="ts">
  import { onMount } from 'svelte'
  import { api, errText, type OllamaStatus, type Settings } from './lib/api'
  import Chat from './lib/Chat.svelte'
  import Models from './lib/Models.svelte'
  import OllamaPathDialog from './lib/OllamaPathDialog.svelte'
  import Terminal from './lib/Terminal.svelte'

  let settings = $state<Settings | null>(null)
  let status = $state<OllamaStatus | null>(null)
  let tab = $state<'chat' | 'models'>('chat')
  let showPathDialog = $state(false)
  let showTerminal = $state(false)
  let busy = $state<'start' | 'stop' | null>(null)

  // What a click on the status LED does in the current state.
  const ledAction = $derived.by((): { label: string; run?: () => void } => {
    if (!status) return { label: 'Checking Ollama…' }
    if (busy) return { label: busy === 'start' ? 'Starting Ollama…' : 'Stopping Ollama…' }
    if (status.running && status.startedByApp) return { label: 'Ollama is running. Click to stop it.', run: () => run('stop') }
    if (status.running) return { label: 'Ollama is running (started outside Talkerbox). Stop it from its tray icon.' }
    if (status.exe) return { label: 'Ollama is stopped. Click to start it.', run: () => run('start') }
    return { label: 'Ollama not found. Click to set its location.', run: () => (showPathDialog = true) }
  })
  let error = $state('')
  // Bumped when models change so the chat view reloads its model list.
  let modelsVersion = $state(0)

  async function refresh() {
    try {
      status = await api.ollamaStatus()
    } catch (e) {
      error = errText(e)
    }
  }

  async function run(action: 'start' | 'stop') {
    busy = action
    error = ''
    try {
      status = await (action === 'start' ? api.ollamaStart() : api.ollamaStop())
      modelsVersion++
    } catch (e) {
      error = `Could not ${action} Ollama: ${errText(e)}`
      await refresh()
    } finally {
      busy = null
    }
  }

  onMount(() => {
    ;(async () => {
      settings = await api.getSettings()
      await refresh()
      if (status && !status.running && !status.exe) showPathDialog = true
    })()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  })

  // Persist settings whenever any field changes (the first run just stores what was loaded).
  $effect(() => {
    if (!settings) return
    const snapshot = $state.snapshot(settings)
    api.saveSettings(snapshot).catch((e) => (error = `Saving settings failed: ${errText(e)}`))
  })
</script>

<header>
  <h1>Talkerbox</h1>
  <nav>
    <button class:active={tab === 'chat'} onclick={() => (tab = 'chat')}>Chat</button>
    <button class:active={tab === 'models'} onclick={() => (tab = 'models')}>Models</button>
  </nav>
  <div class="ollama">
    <span>
      {#if !status}Checking Ollama…
      {:else if busy}{busy === 'start' ? 'Starting Ollama…' : 'Stopping Ollama…'}
      {:else if status.running}Ollama {status.version}{status.startedByApp ? ' (started here)' : ''}
      {:else if status.exe}Ollama stopped
      {:else}Ollama not found{/if}
    </span>
    <button
      class="led"
      class:on={status?.running}
      class:busy={!!busy}
      disabled={!status || !!busy || (status.running && !status.startedByApp)}
      title={ledAction.label}
      aria-label={ledAction.label}
      onclick={ledAction.run}
    ></button>
    <button
      class="ghost icon"
      title="Show Ollama server output"
      aria-label="Show Ollama server output"
      onclick={() => (showTerminal = true)}
    >
      <svg viewBox="0 0 20 16" aria-hidden="true">
        <rect x="0.75" y="0.75" width="18.5" height="14.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M4 5l3 3-3 3M9 11.5h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <button class="ghost" title={status?.exe ?? 'Set ollama.exe location'} onclick={() => (showPathDialog = true)}>Path…</button>
  </div>
</header>

{#if error}
  <div class="banner error" role="alert">{error} <button class="ghost" onclick={() => (error = '')}>Dismiss</button></div>
{/if}

<main>
  {#if settings}
    <div hidden={tab !== 'chat'} class="view"><Chat bind:settings running={!!status?.running} {modelsVersion} /></div>
    <div hidden={tab !== 'models'} class="view">
      <Models running={!!status?.running} onModelsChanged={() => modelsVersion++} />
    </div>
  {/if}
</main>

{#if showTerminal}
  <Terminal
    running={!!status?.running}
    startedByApp={!!status?.startedByApp}
    onClose={() => (showTerminal = false)}
  />
{/if}

{#if showPathDialog}
  <OllamaPathDialog
    current={status?.exe ?? null}
    onClose={() => (showPathDialog = false)}
    onSaved={async (exe) => {
      showPathDialog = false
      if (settings) settings.ollamaPath = exe
      await refresh()    }}
  />
{/if}

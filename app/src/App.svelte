<script lang="ts">
  import { onMount } from 'svelte'
  import { api, errText, type OllamaStatus, type Settings } from './lib/api'
  import Chat from './lib/Chat.svelte'
  import Models from './lib/Models.svelte'
  import OllamaPathDialog from './lib/OllamaPathDialog.svelte'

  let settings = $state<Settings | null>(null)
  let status = $state<OllamaStatus | null>(null)
  let tab = $state<'chat' | 'models'>('chat')
  let showPathDialog = $state(false)
  let busy = $state(false)
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

  async function run(fn: () => Promise<OllamaStatus>) {
    busy = true
    error = ''
    try {
      status = await fn()
      modelsVersion++
    } catch (e) {
      error = errText(e)
      await refresh()
    } finally {
      busy = false
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
    <span class="dot" class:on={status?.running} aria-hidden="true"></span>
    <span>
      {#if !status}Checking Ollama…
      {:else if status.running}Ollama {status.version}{status.startedByApp ? ' (started here)' : ''}
      {:else if status.exe}Ollama stopped
      {:else}Ollama not found{/if}
    </span>
    {#if status && !status.running && status.exe}
      <button disabled={busy} onclick={() => run(api.ollamaStart)}>{busy ? 'Starting…' : 'Start'}</button>
    {/if}
    {#if status?.running && status.startedByApp}
      <button disabled={busy} onclick={() => run(api.ollamaStop)}>Stop</button>
    {/if}
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

{#if showPathDialog}
  <OllamaPathDialog
    current={status?.exe ?? null}
    onClose={() => (showPathDialog = false)}
    onSaved={async (exe) => {
      showPathDialog = false
      if (settings) settings.ollamaPath = exe
      await refresh()
    }}
  />
{/if}

<script lang="ts">
  import { onMount } from 'svelte'
  import { api, errText, type OllamaStatus, type Settings } from './lib/api'
  import Btn from './lib/Btn.svelte'
  import Chat from './lib/Chat.svelte'
  import { fit } from './lib/fit'
  import Icon, { type IconName } from './lib/Icon.svelte'
  import Models from './lib/Models.svelte'
  import OllamaPathDialog from './lib/OllamaPathDialog.svelte'
  import Terminal from './lib/Terminal.svelte'
  import ThemeSwitch from './lib/ThemeSwitch.svelte'

  type View = 'chat' | 'models' | 'speech' | 'server'
  const NAV: { id: View; label: string; icon: IconName; tip: string }[] = [
    { id: 'chat', label: 'Chat', icon: 'chat', tip: 'Talk to the selected model and hear its replies' },
    { id: 'models', label: 'Models', icon: 'cube', tip: 'Manage Ollama models: pull, import, delete' },
    { id: 'speech', label: 'Speech', icon: 'wave', tip: 'Kokoro speech files, voices and language packs' },
    { id: 'server', label: 'Server', icon: 'plug', tip: 'Ollama server status, install path and log' },
  ]

  let settings = $state<Settings | null>(null)
  let status = $state<OllamaStatus | null>(null)
  let view = $state<View>('chat')
  let showPathDialog = $state(false)
  let showTerminal = $state(false)
  let busy = $state<'start' | 'stop' | null>(null)

  // What a click on the status LED does in the current state.
  const ledAction = $derived.by((): { label: string; run?: () => void } => {
    if (!status) return { label: 'Checking Ollama…' }
    if (busy) return { label: busy === 'start' ? 'Starting Ollama…' : 'Stopping Ollama…' }
    if (status.running && status.startedByApp)
      return { label: 'Stop the Ollama server (it is running and was started by Talkerbox).', run: () => run('stop') }
    if (status.running) return { label: 'Ollama is running (started outside Talkerbox). Stop it from its tray icon.' }
    if (status.exe) return { label: 'Start the Ollama server (it is currently stopped).', run: () => run('start') }
    return { label: 'Ollama not found. Click to set its location.', run: () => (showPathDialog = true) }
  })

  // LED colour state and its text label (colour is never the only signal).
  const led = $derived.by((): { state: string; text: string } => {
    if (!status) return { state: 'busy', text: 'Checking…' }
    if (busy) return { state: 'busy', text: busy === 'start' ? 'Starting…' : 'Stopping…' }
    if (status.running && status.startedByApp) return { state: 'running', text: 'Running' }
    if (status.running) return { state: 'external', text: 'Running (external)' }
    if (status.exe) return { state: 'stopped', text: 'Stopped' }
    return { state: 'missing', text: 'Not found' }
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

  const pathTitle = $derived(
    status?.exe ? `Choose a different ollama.exe (current: ${status.exe})` : 'Choose where ollama.exe is installed',
  )
  const logTitle = 'Show the Ollama server output (read-only log of the server Talkerbox started)'
</script>

{#snippet ledButton()}
  <button
    type="button"
    class="ledbtn"
    data-ollama={led.state}
    disabled={!status || !!busy || (status.running && !status.startedByApp)}
    title={ledAction.label}
    aria-label={`Ollama server: ${led.text}. ${ledAction.label}`}
    onclick={ledAction.run}
  >
    <span class="led"></span><span class="st-text">{led.text}</span>
    {#if status?.running && status.version}<span class="ver">v{status.version}</span>{/if}
  </button>
{/snippet}

<div class="shell">
  <nav class="rail" aria-label="Main">
    <div class="rail-brand"><span class="logo-tile"><Icon name="logo" /></span><span class="rl">Talkerbox</span></div>
    <div class="nav">
      {#each NAV as n (n.id)}
        <button
          type="button"
          class="nav-i"
          aria-current={view === n.id ? 'page' : undefined}
          title={n.tip}
          onclick={() => (view = n.id)}><Icon name={n.icon} /><span class="l">{n.label}</span></button
        >
      {/each}
    </div>
    <span class="spacer"></span>
    <section class="rail-status" aria-label="Ollama server">
      <span class="cap">Ollama</span>
      {@render ledButton()}
      <div class="acts">
        <Btn icon="terminal" label="Log" title={logTitle} onclick={() => (showTerminal = true)} />
        <Btn icon="folder" label="Path…" title={pathTitle} onclick={() => (showPathDialog = true)} />
      </div>
    </section>
    <div class="rail-foot"><ThemeSwitch /></div>
  </nav>

  <div class="main">
    {#if error}
      <div class="banners">
        <div class="banner err" role="alert">
          <Icon name="alert" /><div class="body">{error}</div>
          <button type="button" class="ghost sm" title="Hide this error message" onclick={() => (error = '')}>Dismiss</button>
        </div>
      </div>
    {/if}

    {#if settings}
      <section class="view" hidden={view !== 'chat'} aria-label="Chat">
        <Chat bind:settings running={!!status?.running} {modelsVersion} />
      </section>
      <section class="view page" hidden={view !== 'models' && view !== 'speech'} aria-label={view === 'speech' ? 'Speech' : 'Models'}>
        <div class="page-in">
          <Models bind:settings view={view === 'speech' ? 'speech' : 'models'} running={!!status?.running} onModelsChanged={() => modelsVersion++} />
        </div>
      </section>
    {/if}

    <section class="view page" hidden={view !== 'server'} aria-label="Server">
      <div class="page-in">
        <header class="ph">
          <h1>Server</h1>
          <p>Talkerbox starts and stops a locally installed Ollama. The status light is the switch.</p>
        </header>
        <div class="card">
          <div class="card-h"><h2>Ollama</h2></div>
          <div class="srv">{@render ledButton()}<span class="help">{ledAction.label}</span></div>
          <div class="legend" aria-label="Status light legend">
            <span class="lg" data-ollama="stopped"><span class="led"></span>Stopped: click to start</span>
            <span class="lg" data-ollama="busy"><span class="led"></span>Checking, starting or stopping</span>
            <span class="lg" data-ollama="running"><span class="led"></span>Running: click to stop</span>
            <span class="lg" data-ollama="external"><span class="led"></span>Running externally: cannot stop here</span>
            <span class="lg" data-ollama="missing"><span class="led"></span>Not found: click to set the path</span>
          </div>
        </div>
        <div class="card">
          <div class="card-h"><h2>Install path</h2></div>
          <div class="fit" use:fit>
            <input class="grow mono" readonly value={status?.exe ?? 'ollama.exe not found'} aria-label="Path to ollama.exe" title={status?.exe ?? 'ollama.exe not found'} />
            <Btn icon="folder" label="Change path…" short="Path…" title={pathTitle} onclick={() => (showPathDialog = true)} />
          </div>
        </div>
        <div class="card">
          <div class="card-h">
            <h2>Server log</h2>
            <Btn icon="terminal" label="Open log" title={logTitle} onclick={() => (showTerminal = true)} />
          </div>
          <p class="help">Read-only output of the server Talkerbox started. It is captured even while the log is closed.</p>
        </div>
      </div>
    </section>
  </div>
</div>

{#if showTerminal}
  <Terminal running={!!status?.running} startedByApp={!!status?.startedByApp} onClose={() => (showTerminal = false)} />
{/if}

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

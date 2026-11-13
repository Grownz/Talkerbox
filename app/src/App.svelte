<script lang="ts">
  import { onMount } from 'svelte'
  import { api, errText, type OllamaStatus, type Settings } from './lib/api'
  import { avatar, puppetOpen, sendToPuppet, watchPuppet } from './lib/avatar.svelte'
  import AvatarCard from './lib/AvatarCard.svelte'
  import Btn from './lib/Btn.svelte'
  import Chat from './lib/Chat.svelte'
  import { fit } from './lib/fit'
  import Icon, { type IconName } from './lib/Icon.svelte'
  import Models from './lib/Models.svelte'
  import OllamaPathDialog from './lib/OllamaPathDialog.svelte'
  import { nextDelayMs, passMs } from './lib/statusAnim'
  import Terminal from './lib/Terminal.svelte'
  import ThemeSwitch from './lib/ThemeSwitch.svelte'

  type View = 'chat' | 'models' | 'speech' | 'avatar' | 'server'
  const NAV: { id: View; label: string; icon: IconName; tip: string }[] = [
    { id: 'chat', label: 'Chat', icon: 'chat', tip: 'Talk to the selected model and hear its replies' },
    { id: 'models', label: 'Models', icon: 'cube', tip: 'Manage Ollama models: pull, import, delete' },
    { id: 'speech', label: 'Speech', icon: 'wave', tip: 'Kokoro speech files, voices and language packs' },
    { id: 'avatar', label: 'Avatar', icon: 'figure', tip: 'Avatar window, characters, mask and part editors' },
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

  // Decorative status animation over the sidebar LED while the server runs (10 px glyph across the 12 px LED).
  const PASS_MS = passMs(22)
  const ollamaRunning = $derived(!!status?.running)
  let passing = $state(false)
  $effect(() => {
    if (!ollamaRunning || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let t: ReturnType<typeof setTimeout>
    const schedule = () => {
      t = setTimeout(() => {
        passing = true
        t = setTimeout(() => {
          passing = false
          schedule()
        }, PASS_MS)
      }, nextDelayMs())
    }
    schedule()
    return () => {
      clearTimeout(t)
      passing = false
    }
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
      if (status && !status.running) {
        if (!status.exe) showPathDialog = true
        else if (settings.ollamaAutostart) run('start')
      }
    })()
    const timer = setInterval(refresh, 5000)
    const unwatch = watchPuppet(() => ({
      bg: settings?.avatarBg ?? 'normal',
      opacity: settings?.avatarOpacity ?? 100,
      character: settings?.avatarActive ?? null,
      rev: avatar.rev,
    }))
    return () => {
      clearInterval(timer)
      unwatch()
    }
  })

  // Persist settings whenever any field changes (the first run just stores what was loaded).
  $effect(() => {
    if (!settings) return
    const snapshot = $state.snapshot(settings)
    api.saveSettings(snapshot).catch((e) => (error = `Saving settings failed: ${errText(e)}`))
  })

  // Live avatar options; a transparency change makes the backend recreate the open window.
  $effect(() => {
    if (!settings || !avatar.open) return
    const { avatarBg: bg, avatarOpacity: opacity, avatarActive: character } = settings
    sendToPuppet('avatar://options', { bg, opacity, character, rev: avatar.rev })
    puppetOpen(bg === 'transparent').catch((e) => (error = errText(e)))
  })

  const pathTitle = $derived(
    status?.exe ? `Choose a different ollama.exe (current: ${status.exe})` : 'Choose where ollama.exe is installed',
  )
  const logTitle = 'Show the Ollama server output (read-only log of the server Talkerbox started)'
</script>

{#snippet ledButton(rail: boolean)}
  <button
    type="button"
    class="ledbtn"
    data-ollama={led.state}
    disabled={!status || !!busy || (status.running && !status.startedByApp)}
    title={ledAction.label}
    aria-label={`Ollama server: ${led.text}. ${ledAction.label}`}
    onclick={ledAction.run}
  >
    <span class="led"
      >{#if rail && passing}<svg class="led-pass" viewBox="0 0 10 10" aria-hidden="true" style="--pass: {PASS_MS}ms"
          ><path
            fill="currentColor"
            fill-rule="evenodd"
            d="M3 .5c.6 0 .9.8.9 2v.6h2.2v-.6c0-1.2.3-2 .9-2s.9.8.9 2v1.4c.6.5 1 1.3 1 2.3 0 2-1.6 3.3-3.9 3.3S1.1 8.2 1.1 6.2c0-1 .4-1.8 1-2.3V2.5c0-1.2.3-2 .9-2zM3.5 5.6a.5.5 0 1 0 1 0 .5.5 0 1 0-1 0zM5.5 5.6a.5.5 0 1 0 1 0 .5.5 0 1 0-1 0z"
          /></svg
        >{/if}</span
    ><span class="st-text">{led.text}</span>
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
      {@render ledButton(true)}
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
      <section class="view page" hidden={view !== 'avatar'} aria-label="Avatar">
        <div class="page-in">
          <header class="ph">
            <h1>Avatar</h1>
            <p>A figure that talks with the spoken replies: window options, your characters and their editors.</p>
          </header>
          {#if view === 'avatar'}<AvatarCard bind:settings onError={(m) => (error = m)} />{/if}
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
          <div class="srv">{@render ledButton(false)}<span class="help">{ledAction.label}</span></div>
          <div class="legend" aria-label="Status light legend">
            <span class="lg" data-ollama="stopped"><span class="led"></span>Stopped: click to start</span>
            <span class="lg" data-ollama="busy"><span class="led"></span>Checking, starting or stopping</span>
            <span class="lg" data-ollama="running"><span class="led"></span>Running: click to stop</span>
            <span class="lg" data-ollama="external"><span class="led"></span>Running externally: cannot stop here</span>
            <span class="lg" data-ollama="missing"><span class="led"></span>Not found: click to set the path</span>
          </div>
          {#if settings}
            <button
              type="button"
              class="switch"
              role="switch"
              aria-checked={settings.ollamaAutostart}
              aria-label="Start Ollama automatically"
              title={settings.ollamaAutostart
                ? 'Talkerbox starts the Ollama server when it opens; click to turn this off'
                : 'Click to have Talkerbox start the Ollama server when it opens'}
              onclick={() => settings && (settings.ollamaAutostart = !settings.ollamaAutostart)}
              ><span class="track"></span><span class="swl">Start Ollama automatically</span></button
            >
          {/if}

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

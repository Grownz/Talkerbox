<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { api, errText, newOpId, type ChatMessage, type ModelInfo, type Settings, type TtsStatus } from './api'
  import { Speaker } from './speaker'

  let { settings = $bindable(), running, modelsVersion }: { settings: Settings; running: boolean; modelsVersion: number } =
    $props()

  let models = $state<ModelInfo[]>([])
  let messages = $state<ChatMessage[]>([])
  let input = $state('')
  let opId = $state<string | null>(null)
  let error = $state('')
  let tts = $state<TtsStatus | null>(null)
  let ttsBusy = $state(false)
  let voices = $state<string[]>([])
  let log: HTMLElement | undefined = $state()

  const speaker = new Speaker()
  speaker.onError = (m) => (error = m)

  $effect(() => {
    void modelsVersion
    if (running) loadModels()
    // TTS files or folder may have changed in the Models view.
    api.ttsStatus().then((s) => (tts = s), () => {})
  })

  // Keep the newest text visible while streaming.
  $effect(() => {
    void messages.length
    void messages.at(-1)?.content
    tick().then(() => log?.scrollTo({ top: log.scrollHeight }))
  })

  async function loadModels() {
    try {
      models = await api.listModels()
      if (models.length && !models.some((m) => m.name === settings.lastModel)) settings.lastModel = models[0].name
    } catch (e) {
      error = `Could not load models: ${errText(e)}`
    }
  }

  async function loadVoices() {
    try {
      voices = await api.ttsVoices()
      if (!settings.voice || !voices.includes(settings.voice)) {
        settings.voice = voices.includes('af_heart') ? 'af_heart' : (voices[0] ?? null)
      }
    } catch (e) {
      error = `Could not load voices: ${errText(e)}`
    }
  }

  async function startTts() {
    ttsBusy = true
    try {
      tts = await api.ttsStart()
      await loadVoices()
    } catch (e) {
      error = errText(e)
      tts = await api.ttsStatus().catch(() => tts)
    } finally {
      ttsBusy = false
    }
  }

  async function stopTts() {
    speaker.stop()
    tts = await api.ttsStop().catch((e) => ((error = errText(e)), tts))
  }

  async function toggleTts() {
    settings.ttsEnabled = !settings.ttsEnabled
    if (!settings.ttsEnabled) speaker.stop()
    else if (tts && !tts.running && tts.sidecarPresent && tts.modelReady) await startTts()
  }

  onMount(() => {
    ;(async () => {
      tts = await api.ttsStatus().catch(() => null)
      if (tts?.running) await loadVoices()
      else if (settings.ttsEnabled && tts?.sidecarPresent && tts.modelReady) await startTts()
    })()
    return () => speaker.stop()
  })

  async function send() {
    const text = input.trim()
    const model = settings.lastModel
    if (!text || !model || opId) return
    input = ''
    error = ''
    messages.push({ role: 'user', content: text })
    const history = $state.snapshot(messages)
    messages.push({ role: 'assistant', content: '' })
    const reply = messages[messages.length - 1]
    const speak = settings.ttsEnabled && !!tts?.running && !!settings.voice
    if (speak) {
      speaker.stop()
      speaker.unlock()
      speaker.voice = settings.voice!
      speaker.speed = settings.ttsSpeed
    }
    const id = newOpId()
    opId = id
    try {
      await api.chat(id, model, history, (t) => {
        reply.content += t
        if (speak) speaker.feed(t)
      })
      if (speak) speaker.flush()
    } catch (e) {
      error = errText(e)
      if (!reply.content) messages.pop()
    } finally {
      opId = null
    }
  }

  function stop() {
    if (opId) api.cancel(opId)
    speaker.stop()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }
</script>

<div class="toolbar">
  <label>
    Model
    <select bind:value={settings.lastModel} disabled={!running || !models.length}>
      {#each models as m (m.name)}<option value={m.name} title={m.name}>{m.displayName}</option>{/each}
    </select>
  </label>
  <button class="ghost" onclick={() => (messages = [])} disabled={!!opId || !messages.length}>New chat</button>
  <span class="spacer"></span>
  <label class="check"><input type="checkbox" checked={settings.ttsEnabled} onchange={toggleTts} /> Speak replies</label>
  {#if settings.ttsEnabled}
    {#if !tts?.sidecarPresent}
      <span class="muted" title={tts?.sidecarError ?? ''}>TTS unavailable (details in Models)</span>
    {:else if !tts.modelReady}
      <span class="muted">Download the Kokoro files in Models</span>
    {:else if !tts.running}
      <button disabled={ttsBusy} onclick={startTts}>{ttsBusy ? 'Starting TTS…' : 'Start TTS'}</button>
    {:else}
      <select bind:value={settings.voice} aria-label="Voice">
        {#each voices as v (v)}<option value={v}>{v}</option>{/each}
      </select>
      <label title="Speech speed">
        Speed {settings.ttsSpeed.toFixed(1)}
        <input type="range" min="0.5" max="2" step="0.1" bind:value={settings.ttsSpeed} />
      </label>
      <button class="ghost" onclick={() => speaker.stop()}>Stop speaking</button>
      <button class="ghost" onclick={stopTts}>Stop TTS</button>
    {/if}
  {/if}
</div>

{#if error}<div class="banner error" role="alert">{error}</div>{/if}

<div class="log" bind:this={log}>
  {#if !running}
    <p class="muted center">Ollama is not running. Start it from the top bar.</p>
  {:else if !models.length}
    <p class="muted center">No models installed yet. Add one in the Models view.</p>
  {:else if !messages.length}
    <p class="muted center">Say hello to {models.find((m) => m.name === settings.lastModel)?.displayName ?? settings.lastModel}.</p>
  {/if}
  {#each messages as m, i (i)}
    <div class="msg {m.role}">{m.content}{#if opId && i === messages.length - 1 && m.role === 'assistant'}<span class="cursor">▍</span>{/if}</div>
  {/each}
</div>

<div class="composer">
  <textarea bind:value={input} onkeydown={onKey} rows="3" placeholder="Type a message (Enter to send, Shift+Enter for a new line)" disabled={!running}></textarea>
  {#if opId}
    <button onclick={stop}>Stop</button>
  {:else}
    <button onclick={send} disabled={!running || !input.trim() || !settings.lastModel}>Send</button>
  {/if}
</div>

<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { api, errText, newOpId, type ChatMessage, type ModelInfo, type Settings, type TtsStatus } from './api'
  import { Speaker } from './speaker'
  import VoicePicker from './VoicePicker.svelte'

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

  // The checkbox means "TTS is running": a failed start unchecks it again.
  async function startTts() {
    ttsBusy = true
    error = ''
    try {
      tts = await api.ttsStart()
      await loadVoices()
    } catch (e) {
      settings.ttsEnabled = false
      error = `Speech could not start: ${errText(e)}`
      tts = await api.ttsStatus().catch(() => tts)
    } finally {
      ttsBusy = false
    }
  }

  async function onTtsToggle(e: Event) {
    settings.ttsEnabled = (e.currentTarget as HTMLInputElement).checked
    if (settings.ttsEnabled) return startTts()
    speaker.stop()
    tts = await api.ttsStop().catch((err) => ((error = errText(err)), tts))
  }

  const ttsOn = $derived(settings.ttsEnabled && !!tts?.running && !!settings.voice)

  function prepareSpeaker() {
    speaker.stop()
    speaker.unlock()
    speaker.voice = settings.voice!
    speaker.speed = settings.ttsSpeed
  }

  /** Re-reads a reply from the beginning, cancelling whatever is being spoken. */
  function readAloud(text: string) {
    prepareSpeaker()
    speaker.feed(text)
    speaker.flush()
  }

  onMount(() => {
    ;(async () => {
      tts = await api.ttsStatus().catch(() => null)
      if (tts?.running) await loadVoices()
      else if (settings.ttsEnabled) await startTts()
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
    const speak = ttsOn
    if (speak) prepareSpeaker()
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
  <label class="check">
    <input type="checkbox" checked={settings.ttsEnabled} disabled={ttsBusy} onchange={onTtsToggle} />
    {ttsBusy ? 'Starting speech…' : 'Speak replies'}
  </label>
  {#if settings.ttsEnabled && tts?.running}
    <VoicePicker {voices} bind:value={settings.voice} />
    <label title="Speech speed">
      Speed {settings.ttsSpeed.toFixed(1)}
      <input type="range" min="0.5" max="2" step="0.1" bind:value={settings.ttsSpeed} />
    </label>
    <button class="ghost" onclick={() => speaker.stop()}>Stop speaking</button>
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
    {@const streaming = !!opId && i === messages.length - 1 && m.role === 'assistant'}
    {@const canReplay = ttsOn && m.role === 'assistant' && !streaming && !!m.content}
    <div class="msg {m.role}" class:replayable={canReplay}>
      <span class="text">{m.content}</span>{#if streaming}<span class="cursor">▍</span>{/if}
      {#if canReplay}
        <button
          class="replay"
          title="Read this reply aloud from the beginning (stops any current speech)"
          aria-label="Read this reply aloud from the beginning"
          onclick={() => readAloud(m.content)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" fill="currentColor" /></svg>
        </button>
      {/if}
    </div>
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

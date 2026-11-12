<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { listen } from '@tauri-apps/api/event'
  import { joinDraft, sttLanguageName } from './stt'
  import {
    api,
    errText,
    newOpId,
    type ChatMessage,
    type ModelInfo,
    type Settings,
    type TtsStatus,
    type VoiceDetail,
  } from './api'
  import { finalRate, formatRate, liveRate } from './rate'
  import { Speaker } from './speaker'
  import Btn from './Btn.svelte'
  import { fit } from './fit'
  import Icon from './Icon.svelte'
  import VoicePicker from './VoicePicker.svelte'

  let { settings = $bindable(), running, modelsVersion }: { settings: Settings; running: boolean; modelsVersion: number } =
    $props()

  let models = $state<ModelInfo[]>([])
  // `tps`: tokens/s shown in the reply box (live while streaming, final afterwards).
  let messages = $state<(ChatMessage & { tps?: number })[]>([])
  let input = $state('')
  let opId = $state<string | null>(null)
  let error = $state('')
  let tts = $state<TtsStatus | null>(null)
  let ttsBusy = $state(false)
  let voices = $state<string[]>([])
  let voiceDetails = $state<VoiceDetail[]>([])
  let packNames = $state<Record<string, string>>({})
  // Voice for which a synthesize response reported X-TTS-Fallback.
  let fallbackSeenFor = $state<string | null>(null)
  let log: HTMLElement | undefined = $state()

  const speaker = new Speaker()
  speaker.onError = (m) => (error = m)
  speaker.onFallback = (v) => (fallbackSeenFor = v)

  // One persistent hint for the selected voice instead of a message per sentence.
  const usingFallback = $derived(
    !!settings.voice &&
      (voiceDetails.some((d) => d.id === settings.voice && d.fallback) || fallbackSeenFor === settings.voice),
  )

  $effect(() => {
    void modelsVersion
    if (running) loadModels()
    // TTS files or folder may have changed in the Models view.
    api.ttsStatus().then(
      (s) => {
        tts = s
        // Custom voices may have been added or removed (the sidecar was restarted).
        if (s.running && settings.ttsEnabled) loadVoices()
      },
      () => {},
    )
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
      const list = await api.ttsVoices()
      voices = list.voices
      voiceDetails = list.details
      packNames = Object.fromEntries((await api.listPacks().catch(() => [])).map((p) => [p.id, p.name]))
      if (!settings.voice || !voices.includes(settings.voice)) {
        settings.voice = voices.includes('af_heart') ? 'af_heart' : (voices[0] ?? null)
      }
    } catch (e) {
      error = `Could not load voices: ${errText(e)}`
    }
  }

  // The switch means "TTS is running": a failed start turns it off again.
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

  async function onTtsToggle() {
    settings.ttsEnabled = !settings.ttsEnabled
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
    // Speech input events; ignored once listening was stopped here (late events after stop/cancel).
    const draft = (e: { payload: string }) => {
      if (listening) input = joinDraft(sttBase, e.payload)
    }
    const offs = [
      listen<string>('stt://partial', draft),
      listen<string>('stt://final', draft),
      listen<string>('stt://send', (e) => {
        if (!listening) return
        draft(e)
        listening = false
        send()
      }),
      listen<string>('stt://error', (e) => {
        listening = false
        error = e.payload
      }),
    ]
    return () => {
      speaker.stop()
      if (listening) api.sttStop()
      offs.forEach((p) => p.then((off) => off()))
    }
  })

  // ---------- speech input ----------
  let listening = $state(false)
  let sttStarting = $state(false)
  // Composer text from before listening started; the transcript is appended to it.
  let sttBase = ''

  async function toggleMic() {
    if (listening) return stopListening()
    error = ''
    const st = await api.sttStatus().catch((e) => ((error = errText(e)), null))
    if (!st) return
    if (st.runtimeError) {
      error = st.runtimeError
      return
    }
    const lang = settings.sttLanguage
    if (!st.models.some((m) => m.lang === lang && m.installed)) {
      error = `Speech input needs the ${sttLanguageName(lang)} model. Download it on the Speech page under "Speech input".`
      return
    }
    // The microphone must not hear the reply being read aloud.
    speaker.stop()
    sttBase = input
    sttStarting = true
    listening = true
    try {
      await api.sttStart(lang, settings.sttIdleSecs)
    } catch (e) {
      listening = false
      error = errText(e)
    } finally {
      sttStarting = false
    }
  }

  /** Stops listening; the dictated text stays in the box for editing. */
  function stopListening() {
    listening = false
    api.sttStop().catch(() => {})
  }

  function discardDictation() {
    stopListening()
    input = sttBase
  }

  function onSendClick() {
    if (listening) stopListening()
    send()
  }

  async function send() {
    const text = input.trim()
    const model = settings.lastModel
    if (!text || !model || opId) return
    input = ''
    error = ''
    messages.push({ role: 'user', content: text })
    const history: ChatMessage[] = messages.map(({ role, content }) => ({ role, content }))
    messages.push({ role: 'assistant', content: '' })
    const reply = messages[messages.length - 1]
    const speak = ttsOn
    if (speak) prepareSpeaker()
    const id = newOpId()
    opId = id
    // Chunk arrival times; the display updates once per second only, to avoid flicker.
    const stamps: number[] = []
    const timer = setInterval(() => {
      const r = liveRate(stamps, performance.now())
      if (r !== null) reply.tps = r
    }, 1000)
    try {
      const res = await api.chat(id, model, history, (t) => {
        stamps.push(performance.now())
        reply.content += t
        if (speak) speaker.feed(t)
      })
      if (speak) speaker.flush()
      reply.tps = finalRate(res.evalCount, res.evalDuration, stamps) ?? undefined
    } catch (e) {
      error = errText(e)
      if (!reply.content) messages.pop()
    } finally {
      clearInterval(timer)
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
      if (!sttStarting) onSendClick()
    }
  }

  // While listening the textarea is read-only and rarely focused (the mic button is), so Enter is caught window-wide.
  function onWindowKey(e: KeyboardEvent) {
    if (listening && !sttStarting && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSendClick()
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<header class="vhead">
  <div class="fit" use:fit>
    <span class="select-wrap model">
      <select
        bind:value={settings.lastModel}
        aria-label="Chat model"
        disabled={!running || !models.length}
        title={!running ? 'Start Ollama to choose a model' : !models.length ? 'No models installed; add one in the Models view' : 'Ollama model that answers your messages'}
      >
        {#each models as m (m.name)}<option value={m.name} title={m.name}>{m.displayName}</option>{/each}
      </select><Icon name="chev-down" />
    </span>
    <Btn
      icon="plus"
      label="New chat"
      short="New"
      class="ghost"
      title={opId ? 'Wait for the reply to finish (or stop it) before starting a new chat' : 'Clear the conversation and start over'}
      onclick={() => (messages = [])}
      disabled={!!opId || !messages.length}
    />
    <span class="sep"></span>
    <button
      type="button"
      class="switch"
      class:busy={ttsBusy}
      role="switch"
      aria-checked={settings.ttsEnabled}
      aria-label="Speak replies"
      title={ttsBusy ? 'The speech engine is starting' : settings.ttsEnabled ? 'Turn speech off and stop any reading' : 'Start the speech engine and read replies aloud'}
      disabled={ttsBusy}
      onclick={onTtsToggle}><span class="track"></span><span class="swl">{ttsBusy ? 'Starting speech…' : 'Speak replies'}</span></button
    >
    {#if settings.ttsEnabled && tts?.running}
      <VoicePicker {voices} details={voiceDetails} {packNames} bind:value={settings.voice} />
      <label class="range" title="Speaking rate, from 0.5x to 2x; applies from the next reply or replay">
        <Icon name="gauge" /><span class="vh">Speech speed</span>
        <input type="range" min="0.5" max="2" step="0.1" bind:value={settings.ttsSpeed} />
        <output>{settings.ttsSpeed.toFixed(1)}×</output>
      </label>
      <Btn icon="speaker-off" label="Stop speaking" p={1} class="ghost" title="Stop the current speech and drop queued sentences" onclick={() => speaker.stop()} />
    {/if}
  </div>
</header>

{#if error || (settings.ttsEnabled && tts?.running && usingFallback)}
  <div class="banners">
    {#if error}<div class="banner err" role="alert"><Icon name="alert" /><div class="body">{error}</div></div>{/if}
    {#if settings.ttsEnabled && tts?.running && usingFallback}
      <div class="banner warn" role="status">
        <Icon name="alert" />
        <div class="body">
          No fine-tune model installed for this voice - using the base model, pronunciation may be wrong. Add a language
          pack under Speech.
        </div>
      </div>
    {/if}
  </div>
{/if}

<div class="scroll" bind:this={log}>
  <div class="msgs">
    {#if !running || !models.length || !messages.length}
      <div class="empty">
        <div class="art"><Icon name={!running ? 'plug' : !models.length ? 'cube' : 'chat'} /></div>
        {#if !running}
          <h3>Ollama is not running</h3>
          <p>Start it with the status light in the sidebar.</p>
        {:else if !models.length}
          <h3>No models installed yet</h3>
          <p>Add one in the Models view.</p>
        {:else}
          <h3>Say hello to {models.find((m) => m.name === settings.lastModel)?.displayName ?? settings.lastModel}</h3>
          <p>Replies are generated locally by Ollama and can be read aloud by Kokoro.</p>
        {/if}
      </div>
    {/if}
    {#each messages as m, i (i)}
      {@const streaming = !!opId && i === messages.length - 1 && m.role === 'assistant'}
      {@const canReplay = ttsOn && m.role === 'assistant' && !streaming && !!m.content}
      <div class="msg {m.role}">
        <div class="bubble">{m.content}{#if streaming}<span class="caret" aria-hidden="true"></span>{/if}</div>
        {#if m.role === 'assistant'}
          <!-- Fixed footer: the rate keeps its place whether or not the play button is shown. -->
          <div class="meta">
            <span class="tps" class:live={streaming} title="Generation speed in tokens per second (live estimate while streaming, exact value from Ollama when done)">{m.tps !== undefined ? formatRate(m.tps) : ''}</span>
            {#if canReplay}
              <button
                type="button"
                class="replay"
                title="Read this reply aloud from the beginning (stops any current speech)"
                aria-label="Read this reply aloud from the beginning (stops any current speech)"
                onclick={() => readAloud(m.content)}><Icon name="play" /></button
              >
            {:else}
              <span class="replay-slot" aria-hidden="true"></span>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<footer class="composer">
  {#if listening}
    <div class="stt-status" role="status">
      <Icon name="mic" />{sttStarting ? 'Starting the microphone…' : `Listening (${sttLanguageName(settings.sttLanguage)}): sends after ${settings.sttIdleSecs} s without new words`}
    </div>
  {/if}
  <div class="comp-box" class:listening>
    <textarea
      title={listening ? 'Dictated text (in progress); stop listening to edit it' : running ? 'Your message; Enter sends it, Shift+Enter adds a new line' : 'Start Ollama to chat'}
      aria-label="Message"
      bind:value={input}
      onkeydown={onKey}
      rows="2"
      placeholder={listening ? 'Speak now…' : 'Message the model…  Enter to send, Shift+Enter for a new line'}
      disabled={!running}
      readonly={listening}
    ></textarea>
    {#if listening}
      <Btn icon="x" label="Discard" class="ghost" title="Stop listening and discard the dictated text" onclick={discardDictation} disabled={sttStarting} />
    {/if}
    <Btn
      icon="mic"
      label={listening ? 'Stop' : 'Speak'}
      class="mic {listening ? 'on' : 'ghost'}"
      aria-pressed={listening}
      title={sttStarting ? 'The microphone is starting' : listening ? 'Stop listening; the dictated text stays in the box for editing' : `Dictate a message (${sttLanguageName(settings.sttLanguage)}); it is sent after ${settings.sttIdleSecs} s without new words`}
      onclick={toggleMic}
      disabled={sttStarting}
    />
    {#if opId}
      <Btn icon="stop" label="Stop" class="danger" title="Stop generating; the text so far is kept" onclick={stop} />
    {:else}
      <Btn
        icon="send"
        label="Send"
        class="primary"
        title={!running ? 'Start Ollama first' : !settings.lastModel ? 'Choose a model first' : !input.trim() ? 'Type or dictate a message first' : listening ? 'Stop listening and send the text now' : 'Send the message to the model'}
        onclick={onSendClick}
        disabled={!running || !input.trim() || !settings.lastModel || sttStarting}
      />
    {/if}
  </div>
</footer>

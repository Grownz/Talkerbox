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
  import { avatar, avatarShown, toggleAvatar } from './avatar.svelte'
  import Btn from './Btn.svelte'
  import DeviceMenu from './DeviceMenu.svelte'
  import { fit } from './fit'
  import Icon from './Icon.svelte'
  import Reply from './Reply.svelte'
  import VoicePicker from './VoicePicker.svelte'

  let { settings = $bindable(), running, modelsVersion }: { settings: Settings; running: boolean; modelsVersion: number } =
    $props()

  let models = $state<ModelInfo[]>([])
  // `tps`: tokens/s shown in the reply box (live while streaming, final afterwards). `thinking`: the model's reasoning
  // (display only: never spoken, never sent back); `thinkStart`/`thinkEnd`: its first thinking and first answer token.
  let messages = $state<(ChatMessage & { tps?: number; thinking?: string; thinkStart?: number; thinkEnd?: number })[]>([])
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
  // The reply being read aloud (or queued for it): it shows the stop button instead of play.
  let speakingMsg = $state.raw<object | null>(null)
  // The streaming reply whose tokens still go to the speaker; null once it is stopped or replaced.
  let feeding: object | null = null
  speaker.onSpeaking = (on) => {
    // The microphone must not recognise the reply being read aloud: speech input drops audio meanwhile.
    void api.sttMute(on).catch(() => {})
    // Between two streamed sentences the speaker can be idle while the reply is still coming.
    if (!on && speakingMsg !== feeding) speakingMsg = null
  }

  /** Stops all speech, including the rest of a reply that is still streaming. */
  function stopSpeech() {
    feeding = null
    speakingMsg = null
    speaker.stop()
  }

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

  // Keep the newest text visible while streaming: on new messages here, and after each (throttled) reply render.
  const scrollToEnd = () => log?.scrollTo({ top: log.scrollHeight })
  $effect(() => {
    void messages.length
    tick().then(scrollToEnd)
  })

  // The thinking switch is only offered for models that report the "thinking" capability (cached by the backend).
  let canThink = $state(false)
  $effect(() => {
    const model = settings.lastModel
    void models
    canThink = false
    if (!running || !model) return
    let live = true
    api.modelCapabilities(model).then(
      (c) => live && (canThink = c.includes('thinking')),
      () => {},
    )
    return () => (live = false)
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
    stopSpeech()
    tts = await api.ttsStop().catch((err) => ((error = errText(err)), tts))
  }

  const ttsOn = $derived(settings.ttsEnabled && !!tts?.running && !!settings.voice)

  /** Cancels whatever is being spoken and makes `msg` the reply being read. */
  function prepareSpeaker(msg: object) {
    stopSpeech()
    speaker.unlock()
    speaker.voice = settings.voice!
    speaker.speed = settings.ttsSpeed
    speakingMsg = msg
  }

  /** Re-reads a reply from the beginning, cancelling whatever is being spoken. */
  function readAloud(msg: ChatMessage) {
    prepareSpeaker(msg)
    speaker.feed(msg.content)
    speaker.flush()
    if (!speaker.speaking) speakingMsg = null // nothing speakable in it
  }

  onMount(() => {
    // A stale mute (e.g. after a webview reload mid-speech) must not keep the microphone deaf.
    api.sttMute(false).catch(() => {})
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
        if (!continuous) {
          draft(e)
          listening = false
          // A reply in progress queues the text, as in continuous mode, instead of leaving it unsent in the box.
          if (!opId) return void send()
          const text = input.trim()
          input = ''
          if (text) queued = joinDraft(queued, text)
          return
        }
        // Continuous: listening goes on with a fresh transcript; a reply in progress queues the text.
        const text = joinDraft(sttBase, e.payload)
        sttBase = ''
        input = ''
        if (!text) return
        if (opId) queued = joinDraft(queued, text)
        else send(text)
      }),
      listen<string>('stt://error', (e) => {
        listening = false
        continuous = false
        error = e.payload
      }),
    ]
    return () => {
      stopSpeech()
      if (listening) api.sttStop()
      offs.forEach((p) => p.then((off) => off()))
    }
  })

  // ---------- speech input ----------
  let listening = $state(false)
  let sttStarting = $state(false)
  // Composer text from before listening started; the transcript is appended to it.
  let sttBase = ''
  // Continuous mode (mic button held 5 s): every send keeps listening, until the mic button is pressed again.
  let continuous = $state(false)
  // Dictated text that came in while a reply was still generating; sent when it is done.
  let queued = $state('')
  let notice = $state('')
  let micMenu = $state(false)
  let micWrap: HTMLElement | undefined = $state()

  async function toggleMic() {
    if (listening) return stopListening()
    return startListening(false)
  }

  async function startListening(cont: boolean) {
    error = ''
    notice = ''
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
    stopSpeech()
    sttBase = input
    sttStarting = true
    listening = true
    continuous = cont
    try {
      notice = (await api.sttStart(lang, settings.sttIdleSecs, settings.sttDevice, cont)) ?? ''
    } catch (e) {
      listening = false
      continuous = false
      error = errText(e)
    } finally {
      sttStarting = false
    }
  }

  /** Stops listening; the dictated text stays in the box for editing. */
  function stopListening() {
    listening = false
    continuous = false
    api.sttStop().catch(() => {})
  }

  function discardDictation() {
    stopListening()
    input = sttBase
    queued = ''
  }

  // ---------- hold the mic button for continuous listening ----------
  const HOLD_MS = 5000
  let holding = $state(false)
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  // The hold completed: swallow the click that follows the release.
  let holdDone = false
  // Enter/Space is down on the mic button (auto-repeat must not reach the window Enter handler).
  let keyDown = false

  function holdStart() {
    holdDone = false
    if (listening || sttStarting) return
    holding = true
    holdTimer = setTimeout(() => {
      holding = false
      holdDone = true
      startListening(true)
    }, HOLD_MS)
  }

  /** Released or left early; returns true if a hold was cancelled (a short press). */
  function holdCancel(): boolean {
    clearTimeout(holdTimer)
    const was = holding
    holding = false
    return was
  }

  function onMicClick() {
    if (holdDone) {
      holdDone = false
      return
    }
    toggleMic()
  }

  function onMicPointerDown(e: PointerEvent) {
    if (e.button === 0) holdStart()
  }

  // Enter would click on keydown (and repeat): handle Enter and Space by hand so a hold never also toggles.
  function onMicKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      if (listening && !keyDown) return // Enter while listening keeps its window-wide meaning (send now).
      e.preventDefault()
      e.stopPropagation()
      if (!keyDown && !e.repeat) {
        keyDown = true
        holdStart()
      }
    }
  }

  function onMicKeyUp(e: KeyboardEvent) {
    if ((e.key === 'Enter' || e.key === ' ') && keyDown) {
      e.preventDefault()
      keyDown = false
      if (holdCancel()) toggleMic()
      holdDone = false
    }
  }

  function onMicContextMenu(e: MouseEvent) {
    e.preventDefault()
    holdCancel()
    micMenu = true
  }

  function onSendClick() {
    if (listening) stopListening()
    send()
  }

  /** Sends `given` (dictated in continuous mode) or the composer text. */
  async function send(given?: string) {
    const text = (given ?? input).trim()
    const model = settings.lastModel
    if (!text || !model || opId) return
    if (given === undefined) input = ''
    error = ''
    messages.push({ role: 'user', content: text })
    const history: ChatMessage[] = messages.map(({ role, content }) => ({ role, content }))
    messages.push({ role: 'assistant', content: '' })
    const reply = messages[messages.length - 1]
    if (ttsOn) {
      prepareSpeaker(reply)
      feeding = reply
    }
    const id = newOpId()
    opId = id
    // Chunk arrival times; the display updates once per second only, to avoid flicker.
    const stamps: number[] = []
    const timer = setInterval(() => {
      const r = liveRate(stamps, performance.now())
      if (r !== null) reply.tps = r
    }, 1000)
    try {
      const res = await api.chat(
        id,
        model,
        history,
        (t) => {
          stamps.push(performance.now())
          if (reply.thinkStart !== undefined) reply.thinkEnd ??= performance.now()
          reply.content += t
          if (feeding === reply) speaker.feed(t)
        },
        {
          think: settings.think,
          onThinking: (t) => {
            reply.thinkStart ??= performance.now()
            reply.thinking = (reply.thinking ?? '') + t
          },
        },
      )
      if (feeding === reply) speaker.flush()
      reply.tps = finalRate(res.evalCount, res.evalDuration, stamps) ?? undefined
    } catch (e) {
      error = errText(e)
      if (!reply.content) messages.pop()
    } finally {
      clearInterval(timer)
      if (reply.thinkStart !== undefined) reply.thinkEnd ??= performance.now() // stopped while still thinking
      opId = null
      if (feeding === reply) {
        feeding = null
        if (!speaker.speaking) speakingMsg = null // done, or nothing speakable
      }
    }
    if (queued) {
      const next = queued
      queued = ''
      send(next)
    }
  }

  function stop() {
    if (opId) api.cancel(opId)
    stopSpeech()
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
    {#if canThink}
      <Btn
        icon="bulb"
        label="Thinking"
        short="Think"
        class="ghost"
        aria-pressed={settings.think}
        title="Let the model think before it answers (slower start, often better answers). Off = answers start right away."
        onclick={() => (settings.think = !settings.think)}
      />
    {/if}
    <Btn
      icon="plus"
      label="New chat"
      short="New"
      p={-1}
      class="ghost"
      title={opId ? 'Wait for the reply to finish (or stop it) before starting a new chat' : 'Clear the conversation and start over (stops any reading)'}
      onclick={() => {
        stopSpeech()
        messages = []
      }}
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
    {/if}
    <Btn
      icon="user"
      label="Avatar"
      class="ghost"
      aria-pressed={avatarShown()}
      title={avatar.docked ? 'Hide the avatar docked in the sidebar' : avatar.open ? 'Close the avatar window' : 'Open the avatar window: a figure that moves its mouth while replies are spoken (options on the Avatar page)'}
      onclick={() => toggleAvatar(settings.avatarBg).catch((e) => (error = errText(e)))}
    />
  </div>
</header>

{#if error || notice || (settings.ttsEnabled && tts?.running && usingFallback)}
  <div class="banners">
    {#if error}<div class="banner err" role="alert"><Icon name="alert" /><div class="body">{error}</div></div>{/if}
    {#if notice}<div class="banner warn" role="status"><Icon name="alert" /><div class="body">{notice}</div></div>{/if}
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
      {@const speaking = m === speakingMsg}
      {@const canReplay = ttsOn && m.role === 'assistant' && !streaming && !!m.content}
      {@const replayTip = speaking
        ? 'Stop reading this reply aloud'
        : 'Read this reply aloud from the beginning (stops any current speech)'}
      <div class="msg {m.role}">
        {#if m.role === 'assistant'}
          <Reply text={m.content} thinking={m.thinking} thinkStart={m.thinkStart} thinkEnd={m.thinkEnd} {streaming} onrender={scrollToEnd} />
        {:else}
          <div class="bubble">{m.content}</div>
        {/if}
        {#if m.role === 'assistant'}
          <!-- Fixed footer: the rate keeps its place whether or not the play button is shown. -->
          <div class="meta">
            <span class="tps" class:live={streaming} title="Generation speed in tokens per second (live estimate while streaming, exact value from Ollama when done)">{m.tps !== undefined ? formatRate(m.tps) : ''}</span>
            {#if speaking || canReplay}
              <!-- One element for play and stop, so keyboard focus stays on it when it toggles. -->
              <button
                type="button"
                class="replay"
                class:speaking
                title={replayTip}
                aria-label={replayTip}
                onclick={() => (speaking ? stopSpeech() : readAloud(m))}><Icon name={speaking ? 'stop' : 'play'} /></button
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
  <!-- Always present so screen readers announce the hold progress and mode changes. -->
  <div class="stt-status" role="status" hidden={!listening && !holding && !queued}>
    {#if holding}
      <Icon name="mic" />Hold to keep listening… (5 s)
    {:else if listening}
      <Icon name="mic" />{sttStarting
        ? 'Starting the microphone…'
        : continuous
          ? `Continuous listening (${sttLanguageName(settings.sttLanguage)}): sends after ${settings.sttIdleSecs} s without new words or at a sentence end after about 100 words, then keeps listening`
          : `Listening (${sttLanguageName(settings.sttLanguage)}): sends after ${settings.sttIdleSecs} s without new words`}
      {#if queued}<span class="queued">· text queued until the reply is done</span>{/if}
    {:else if queued}
      <Icon name="mic" />Dictated text queued until the reply is done
    {/if}
  </div>
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
    <span class="mic-wrap" class:holding bind:this={micWrap}>
      <Btn
        icon="mic"
        label={listening ? 'Stop' : 'Speak'}
        class="mic {listening ? 'on' : 'ghost'} {continuous ? 'locked' : ''}"
        aria-pressed={listening}
        aria-haspopup="menu"
        aria-expanded={micMenu}
        title={sttStarting
          ? 'The microphone is starting'
          : continuous
            ? 'Continuous listening is on: each pause sends the text and listening goes on. Click to stop'
            : listening
              ? 'Stop listening; the dictated text stays in the box for editing'
              : `Dictate a message (${sttLanguageName(settings.sttLanguage)}); it is sent after ${settings.sttIdleSecs} s without new words. Hold 5 s to keep listening after each send. Right-click (or Shift+F10) to choose the microphone`}
        onclick={onMicClick}
        onpointerdown={onMicPointerDown}
        onpointerup={holdCancel}
        onpointerleave={holdCancel}
        onpointercancel={holdCancel}
        onkeydown={onMicKeyDown}
        onkeyup={onMicKeyUp}
        onblur={() => ((keyDown = false), holdCancel())}
        oncontextmenu={onMicContextMenu}
        disabled={sttStarting}
      />
      {#if holding}
        <svg class="hold-ring" aria-hidden="true" style="--hold: {HOLD_MS}ms"><rect pathLength="100" /></svg>
      {/if}
      {#if continuous}<span class="lock-badge" aria-hidden="true">∞</span>{/if}
    </span>
    {#if micMenu && micWrap}
      <DeviceMenu anchor={micWrap.querySelector('button') ?? micWrap} bind:value={settings.sttDevice} {listening} onClose={() => (micMenu = false)} />
    {/if}

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

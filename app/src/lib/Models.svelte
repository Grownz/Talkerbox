<script lang="ts">
  import { ask, open } from '@tauri-apps/plugin-dialog'
  import { api, errText, formatBytes, progressText, type ModelInfo, type TtsFile, type TtsStatus } from './api'
  import { Job } from './job.svelte'
  import JobStatus from './JobStatus.svelte'

  let { running, onModelsChanged }: { running: boolean; onModelsChanged: () => void } = $props()

  let models = $state<ModelInfo[]>([])
  let listError = $state('')
  let pullInput = $state('')
  let ggufUrl = $state('')
  let ggufName = $state('')
  let ttsUrl = $state('')
  let tts = $state<TtsStatus | null>(null)

  const pull = new Job()
  const gguf = new Job()
  const ttsJob = new Job()

  $effect(() => {
    if (running) refresh()
  })
  $effect(() => {
    api.ttsStatus().then((s) => (tts = s), () => {})
  })

  async function refresh() {
    listError = ''
    try {
      models = await api.listModels()
    } catch (e) {
      listError = errText(e)
    }
  }

  async function remove(name: string) {
    if (!(await ask(`Delete model "${name}" from Ollama? This cannot be undone.`, { title: 'Delete model', kind: 'warning' })))
      return
    try {
      await api.deleteModel(name)
      await refresh()
      onModelsChanged()
    } catch (e) {
      listError = errText(e)
    }
  }

  async function doPull() {
    if (await pull.run((id, p) => api.pullModel(id, pullInput, p), 'Model pulled.')) {
      pullInput = ''
      await refresh()
      onModelsChanged()
    }
  }

  // Suggest a model name from the .gguf file name.
  function suggestName() {
    if (ggufName) return
    const file = ggufUrl.split(/[?#]/)[0].split('/').pop() ?? ''
    ggufName = file.replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  }

  async function doImport() {
    if (await gguf.run((id, p) => api.importGgufUrl(id, ggufUrl, ggufName, p), `Imported as ${ggufName}.`)) {
      ggufUrl = ''
      ggufName = ''
      await refresh()
      onModelsChanged()
    }
  }

  async function downloadTts(url: string) {
    await ttsJob.run((id, p) => api.downloadTtsFile(id, url, p), 'Downloaded.')
    tts = await api.ttsStatus().catch(() => tts)
    if (tts?.modelReady) showTtsDownloads = false
    onModelsChanged()
  }

  let showTtsDownloads = $state(false)
  let ttsError = $state('')

  async function ttsAction(fn: () => Promise<TtsStatus>) {
    ttsError = ''
    try {
      tts = await fn()
      onModelsChanged()
    } catch (e) {
      ttsError = errText(e)
    }
  }

  async function chooseTtsDir() {
    const dir = await open({ directory: true, title: 'Select a folder containing the Kokoro .onnx and voices .bin files' })
    if (typeof dir === 'string') await ttsAction(() => api.setTtsModelDir(dir))
  }

  const voiceJob = new Job()
  let customVoices = $state<TtsFile[]>([])
  let showVoiceInput = $state(false)
  let voiceUrl = $state('')

  async function loadCustomVoices() {
    customVoices = await api.listCustomVoices().catch(() => [])
  }
  $effect(() => {
    loadCustomVoices()
  })

  async function addVoice() {
    if (await voiceJob.run((id, p) => api.downloadVoice(id, voiceUrl, p), 'Voice installed.')) {
      voiceUrl = ''
      showVoiceInput = false
    }
    await loadCustomVoices()
    onModelsChanged()
  }

  async function removeVoice(name: string) {
    if (!(await ask(`Delete voice file "${name}"?`, { title: 'Delete voice', kind: 'warning' }))) return
    ttsError = ''
    try {
      await api.deleteCustomVoice(name)
    } catch (e) {
      ttsError = errText(e)
    }
    await loadCustomVoices()
    onModelsChanged()
  }

  async function deleteTts() {
    const ok = await ask('Delete the downloaded Kokoro model and voices files? You can download them again later.', {
      title: 'Delete TTS files',
      kind: 'warning',
    })
    if (ok) await ttsAction(api.deleteTtsFiles)
  }
</script>

<section>
  <div class="section-head">
    <h2>Installed Ollama models</h2>
    <button class="ghost" onclick={refresh} disabled={!running}>Refresh</button>
  </div>
  {#if !running}
    <p class="muted">Start Ollama to manage models.</p>
  {:else if listError}
    <p class="error">{listError}</p>
  {:else if !models.length}
    <p class="muted">No models installed.</p>
  {:else}
    <table>
      <thead><tr><th>Name</th><th>Size</th><th>Params</th><th>Quant</th><th></th></tr></thead>
      <tbody>
        {#each models as m (m.name)}
          <tr>
            <td title={m.name}>{m.displayName}{#if m.displayName !== m.name}<br /><small class="muted">{m.name}</small>{/if}</td>
            <td>{formatBytes(m.size)}</td>
            <td>{m.details.parameterSize ?? ''}</td>
            <td>{m.details.quantizationLevel ?? ''}</td>
            <td><button class="ghost danger" onclick={() => remove(m.name)}>Delete</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<section>
  <h2>Pull from HuggingFace or the Ollama library</h2>
  <p class="muted">
    Paste a HuggingFace link, <code>hf.co/user/repo:Q4_K_M</code>, or a library name like <code>llama3.2:3b</code>. The
    repository must contain GGUF files.
  </p>
  <div class="row">
    <input bind:value={pullInput} placeholder="https://huggingface.co/user/repo-GGUF" disabled={pull.busy} />
    {#if pull.busy}
      <button onclick={() => pull.cancel()}>Cancel</button>
    {:else}
      <button onclick={doPull} disabled={!running || !pullInput.trim()}>Pull</button>
    {/if}
  </div>
  <JobStatus job={pull} text={progressText(pull.progress)} />
</section>

<section>
  <h2>Import GGUF from URL</h2>
  <p class="muted">
    Direct link to a <code>.gguf</code> file on any host. Interrupted downloads resume on retry. The downloaded file is
    removed after Ollama has imported it.
  </p>
  <div class="row">
    <input bind:value={ggufUrl} onchange={suggestName} placeholder="https://example.com/model-Q4_K_M.gguf" disabled={gguf.busy} />
  </div>
  <div class="row">
    <input bind:value={ggufName} placeholder="Model name in Ollama" disabled={gguf.busy} />
    {#if gguf.busy}
      <button onclick={() => gguf.cancel()}>Cancel</button>
    {:else}
      <button onclick={doImport} disabled={!running || !ggufUrl.trim() || !ggufName.trim()}>Download & import</button>
    {/if}
  </div>
  <JobStatus job={gguf} text={progressText(gguf.progress)} />
</section>

<section>
  <h2>Text-to-speech model (Kokoro)</h2>
  {#if tts}
    {#if !tts.sidecarPresent}
      <p class="error">{tts.sidecarError}</p>
    {/if}
    <p class="muted">Folder: <code>{tts.modelDir}</code>{tts.customDir ? ' (your folder)' : ''}</p>
    {#if tts.modelReady && tts.modelFile && tts.voicesFile}
      <p class="ok">
        Installed: {tts.modelFile.name} ({formatBytes(tts.modelFile.size)}), {tts.voicesFile.name} ({formatBytes(
          tts.voicesFile.size,
        )})
      </p>
    {:else}
      <p class="muted">Kokoro files missing. Download them, or use a folder that already has them.</p>
    {/if}
    <div class="row">
      <button class="ghost" onclick={chooseTtsDir}>Use existing folder…</button>
      {#if tts.customDir}
        <button class="ghost" onclick={() => ttsAction(() => api.setTtsModelDir(null))}>Use default folder</button>
      {:else if tts.modelReady}
        <button class="ghost" onclick={() => (showTtsDownloads = !showTtsDownloads)}>
          {showTtsDownloads ? 'Hide downloads' : 'Re-download…'}
        </button>
        <button class="ghost danger" disabled={ttsJob.busy} onclick={deleteTts}>Delete files</button>
      {/if}
    </div>
    {#if ttsError}<p class="error" role="alert">{ttsError}</p>{/if}
    {#if !tts.modelReady || showTtsDownloads || ttsJob.busy}
      <div class="row">
        <button disabled={ttsJob.busy} onclick={() => downloadTts(tts!.defaultModelUrl)}>Download kokoro-v1.0.onnx</button>
        <button disabled={ttsJob.busy} onclick={() => downloadTts(tts!.defaultVoicesUrl)}>Download voices-v1.0.bin</button>
      </div>
      <div class="row">
        <input bind:value={ttsUrl} placeholder="Other TTS file URL (.onnx / .bin)" disabled={ttsJob.busy} />
        {#if ttsJob.busy}
          <button onclick={() => ttsJob.cancel()}>Cancel</button>
        {:else}
          <button onclick={() => downloadTts(ttsUrl)} disabled={!ttsUrl.trim()}>Download</button>
        {/if}
      </div>
    {/if}
  {/if}
  <JobStatus job={ttsJob} text={progressText(ttsJob.progress)} />

  <h3>Extra voices</h3>
  <p class="muted">
    Kokoro voice files (.pt, .npy, .npz, .bin, max 50 MB) from a HuggingFace link or any direct URL. The voice id is the
    file name without extension, e.g. <code>af_custom</code>.
  </p>
  {#if customVoices.length}
    <ul class="voice-files">
      {#each customVoices as v (v.name)}
        <li>
          <code>{v.name}</code> <span class="muted">{formatBytes(v.size)}</span>
          <button class="ghost danger" disabled={voiceJob.busy} onclick={() => removeVoice(v.name)}>Delete</button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if showVoiceInput || voiceJob.busy}
    <div class="row">
      <input
        bind:value={voiceUrl}
        placeholder="https://huggingface.co/hexgrad/Kokoro-82M/blob/main/voices/af_heart.pt"
        disabled={voiceJob.busy}
      />
      {#if voiceJob.busy}
        <button onclick={() => voiceJob.cancel()}>Cancel</button>
      {:else}
        <button onclick={addVoice} disabled={!voiceUrl.trim()}>Download</button>
        <button class="ghost" onclick={() => (showVoiceInput = false)}>Close</button>
      {/if}
    </div>
  {:else}
    <div class="row"><button class="ghost" onclick={() => (showVoiceInput = true)}>Add voice from link…</button></div>
  {/if}
  <JobStatus job={voiceJob} text={progressText(voiceJob.progress)} />
</section>

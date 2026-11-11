<script lang="ts">
  import { ask } from '@tauri-apps/plugin-dialog'
  import { api, errText, formatBytes, progressText, type ModelInfo, type TtsStatus } from './api'
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
    if (!(await ask(`Delete model "${name}" from Ollama?`, { title: 'Delete model', kind: 'warning' }))) return
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
            <td>{m.name}</td>
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
    <p class="muted">
      Stored in <code>{tts.modelDir}</code>. Status: {tts.modelReady ? 'model and voices present' : 'files missing'}.
      {#if !tts.sidecarPresent}The TTS sidecar is not installed, so speech stays off until it is.{/if}
    </p>
    <div class="row">
      <button disabled={ttsJob.busy} onclick={() => downloadTts(tts!.defaultModelUrl)}>Download kokoro-v1.0.onnx</button>
      <button disabled={ttsJob.busy} onclick={() => downloadTts(tts!.defaultVoicesUrl)}>Download voices-v1.0.bin</button>
    </div>
  {/if}
  <div class="row">
    <input bind:value={ttsUrl} placeholder="Other TTS file URL (.onnx / .bin)" disabled={ttsJob.busy} />
    {#if ttsJob.busy}
      <button onclick={() => ttsJob.cancel()}>Cancel</button>
    {:else}
      <button onclick={() => downloadTts(ttsUrl)} disabled={!ttsUrl.trim()}>Download</button>
    {/if}
  </div>
  <JobStatus job={ttsJob} text={progressText(ttsJob.progress)} />
</section>

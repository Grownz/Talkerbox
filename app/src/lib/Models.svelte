<script lang="ts">
  import { ask, open } from '@tauri-apps/plugin-dialog'
  import {
    api,
    errText,
    formatBytes,
    progressText,
    type FeaturedPack,
    type LinkInfo,
    type ModelInfo,
    type Pack,
    type TtsFile,
    type TtsStatus,
  } from './api'
  import { FLAGS } from './flags'
  import PackDialog from './PackDialog.svelte'
  import { languageInfo } from './voices'
  import { Job } from './job.svelte'
  import JobStatus from './JobStatus.svelte'
  import Btn from './Btn.svelte'
  import { fit } from './fit'
  import Icon from './Icon.svelte'

  // One instance serves both pages so jobs and inputs survive switching between them.
  let {
    view,
    running,
    onModelsChanged,
  }: { view: 'models' | 'speech'; running: boolean; onModelsChanged: () => void } = $props()

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
  let voiceUrl = $state('')

  async function loadCustomVoices() {
    customVoices = await api.listCustomVoices().catch(() => [])
  }
  $effect(() => {
    loadCustomVoices()
  })

  // Packs
  let packs = $state<Pack[]>([])
  let packDialog = $state<{ url: string; info: LinkInfo } | null>(null)
  let linkChecking = $state(false)
  let packVoiceFor = $state<string | null>(null)
  let packVoiceUrl = $state('')
  const packVoiceJob = new Job()

  async function loadPacks() {
    packs = await api.listPacks().catch(() => [])
    featured = await api.listFeatured().catch(() => [])
  }

  // Featured packs: one Job per pack so both can be installed (also at the same time).
  let featured = $state<FeaturedPack[]>([])
  const featuredJobs: Record<string, Job> = {}
  const featuredJob = (id: string) => (featuredJobs[id] ??= new Job())

  async function installFeatured(f: FeaturedPack) {
    await featuredJob(f.id).run((id, p) => api.installFeatured(id, f.id, p), `${f.name} installed.`)
    await loadPacks()
    onModelsChanged()
  }
  $effect(() => {
    loadPacks()
  })

  /** Voice links install directly; .onnx models open the language-pack dialog. */
  async function addFromLink() {
    voiceJob.error = ''
    voiceJob.result = ''
    linkChecking = true
    let info: LinkInfo
    try {
      info = await api.ttsLinkInfo(voiceUrl)
    } catch (e) {
      voiceJob.error = errText(e)
      return
    } finally {
      linkChecking = false
    }
    if (info.kind === 'model') {
      packDialog = { url: voiceUrl.trim(), info }
      return
    }
    if (info.kind === 'vocab') {
      voiceJob.error = 'A vocab file belongs to a language pack: add the .onnx model link first.'
      return
    }
    if (await voiceJob.run((id, p) => api.downloadVoice(id, voiceUrl, p), 'Voice installed.')) voiceUrl = ''
    await loadCustomVoices()
    onModelsChanged()
  }

  async function packCreated() {
    packDialog = null
    voiceUrl = ''
    await loadPacks()
    onModelsChanged()
  }

  async function addPackVoice(packId: string) {
    if (await packVoiceJob.run((id, p) => api.addPackVoice(id, packId, packVoiceUrl, p), 'Voice added to pack.')) {
      packVoiceUrl = ''
      packVoiceFor = null
    }
    await loadPacks()
    onModelsChanged()
  }

  async function removePack(p: Pack) {
    if (!(await ask(`Delete the language pack "${p.name}" with its model and voices?`, { title: 'Delete pack', kind: 'warning' })))
      return
    ttsError = ''
    try {
      await api.deletePack(p.id)
    } catch (e) {
      ttsError = errText(e)
    }
    await loadPacks()
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

{#snippet flag(language: string)}
  {@const lang = languageInfo(language)}
  {#if lang && FLAGS[lang.country]}<img class="flag" src={FLAGS[lang.country]} alt="" />{:else}<Icon name="globe" class="flag" />{/if}
{/snippet}

{#if view === 'models'}
  <header class="ph">
    <h1>Models</h1>
    <p>Language models served by your local Ollama.</p>
  </header>

  <div class="card">
    <div class="card-h">
      <h2>Installed Ollama models</h2>
      {#if running && models.length}<span class="badge">{models.length} · {formatBytes(models.reduce((a, m) => a + m.size, 0))}</span>{/if}
      <Btn icon="refresh" label="Refresh" class="ghost sm" title={running ? 'Reload the list of installed Ollama models' : 'Start Ollama to list its models'} onclick={refresh} disabled={!running} />
    </div>
    {#if !running}
      <div class="empty-inline">Start Ollama to manage models.</div>
    {:else if listError}
      <p class="err-text" role="alert">{listError}</p>
    {:else if !models.length}
      <div class="empty-inline">No models installed. Pull one below.</div>
    {:else}
      <div class="list">
        {#each models as m (m.name)}
          <div class="item">
            <span class="ic"><Icon name="cube" /></span>
            <span class="txt">
              <span class="n" title={m.name}>{m.displayName}</span>
              <span class="s">{[m.displayName !== m.name ? m.name : '', m.details.parameterSize, m.details.quantizationLevel].filter(Boolean).join(' · ')}</span>
            </span>
            <span class="size">{formatBytes(m.size)}</span>
            <button type="button" class="icon-only ghost danger" title={`Remove ${m.name} from Ollama (asks for confirmation)`} aria-label={`Delete ${m.name}`} onclick={() => remove(m.name)}><Icon name="trash" /></button>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="card">
    <div class="card-h"><h2>Pull from HuggingFace or the Ollama library</h2></div>
    <p class="help">
      Paste a HuggingFace link, <code>hf.co/user/repo:Q4_K_M</code>, or a library name like <code>llama3.2:3b</code>. The
      repository must contain GGUF files.
    </p>
    <div class="fit" use:fit>
      <input class="grow mono" aria-label="Model to pull" title="HuggingFace link, hf.co/user/repo:quant or an Ollama library name" bind:value={pullInput} placeholder="https://huggingface.co/user/repo-GGUF" disabled={pull.busy} spellcheck="false" />
      {#if pull.busy}
        <Btn icon="x" label="Cancel" title="Stop pulling; Ollama keeps finished layers" onclick={() => pull.cancel()} />
      {:else}
        <Btn icon="download" label="Pull model" short="Pull" class="primary" title={!running ? 'Start Ollama first' : !pullInput.trim() ? 'Paste a link or model name first' : 'Download this model into Ollama'} onclick={doPull} disabled={!running || !pullInput.trim()} />
      {/if}
    </div>
    <JobStatus job={pull} text={progressText(pull.progress)} />
  </div>

  <div class="card">
    <div class="card-h"><h2>Import GGUF from URL</h2></div>
    <p class="help">
      Direct link to a <code>.gguf</code> file on any host. Interrupted downloads resume on retry. The downloaded file is
      removed after Ollama has imported it.
    </p>
    <input class="mono" aria-label=".gguf link" title="Direct http(s) link to a .gguf file" bind:value={ggufUrl} onchange={suggestName} placeholder="https://example.com/model-Q4_K_M.gguf" disabled={gguf.busy} spellcheck="false" />
    <div class="fit" use:fit>
      <input class="grow" aria-label="Model name in Ollama" title="Name the model will get in Ollama" bind:value={ggufName} placeholder="Model name in Ollama" disabled={gguf.busy} spellcheck="false" />
      {#if gguf.busy}
        <Btn icon="x" label="Cancel" title="Stop; the partial download resumes next time" onclick={() => gguf.cancel()} />
      {:else}
        <Btn icon="link" label="Download & import" short="Import" class="primary" title={!running ? 'Start Ollama first' : !ggufUrl.trim() || !ggufName.trim() ? 'Enter the .gguf link and a model name first' : 'Download the file, import it into Ollama, then delete the download'} onclick={doImport} disabled={!running || !ggufUrl.trim() || !ggufName.trim()} />
      {/if}
    </div>
    <JobStatus job={gguf} text={progressText(gguf.progress)} />
  </div>
{:else}
  <header class="ph">
    <h1>Speech</h1>
    <p>Offline text-to-speech with Kokoro, language packs and custom voices.</p>
  </header>

  <div class="card">
    <div class="card-h">
      <h2>Text-to-speech model (Kokoro)</h2>
      {#if tts}<span class="badge" class:ok={tts.modelReady}><span class="dot"></span>{tts.modelReady ? 'Installed' : 'Not installed'}</span>{/if}
    </div>
    {#if tts}
      {#if !tts.sidecarPresent}
        <div class="banner err" role="alert"><Icon name="alert" /><div class="body">{tts.sidecarError}</div></div>
      {/if}
      {#if tts.modelReady && tts.modelFile && tts.voicesFile}
        <div class="list">
          {#each [tts.modelFile, tts.voicesFile] as f (f.name)}
            <div class="item">
              <span class="ic"><Icon name="file" /></span>
              <span class="txt"><span class="n mono">{f.name}</span></span>
              <span class="size">{formatBytes(f.size)}</span>
              <span class="badge ok" title="Installed"><Icon name="check" /></span>
            </div>
          {/each}
        </div>
      {:else}
        <p class="help">Kokoro files missing. Download them, or use a folder that already has them.</p>
      {/if}
      <p class="help">Folder: <code>{tts.modelDir}</code>{tts.customDir ? ' (your folder)' : ''}</p>
      <div class="fit" use:fit>
        <Btn icon="folder" label="Use existing folder…" short="Folder…" p={2} title="Use Kokoro model files from a folder you already have instead of downloading them" onclick={chooseTtsDir} />
        {#if tts.customDir}
          <Btn icon="refresh" label="Use default folder" short="Default" p={1} title="Go back to the Kokoro files in the app data folder" onclick={() => ttsAction(() => api.setTtsModelDir(null))} />
        {:else if tts.modelReady}
          <Btn icon="download" label={showTtsDownloads ? 'Hide downloads' : 'Re-download…'} short={showTtsDownloads ? 'Hide' : 'Re-dl…'} p={1} title={showTtsDownloads ? 'Hide the download buttons' : 'Show the download buttons to fetch the Kokoro files again'} onclick={() => (showTtsDownloads = !showTtsDownloads)} />
          <span class="spacer"></span>
          <Btn icon="trash" label="Delete files" short="Delete" class="danger" title={ttsJob.busy ? 'Wait for the download to finish' : 'Delete the downloaded Kokoro model and voices (asks for confirmation)'} disabled={ttsJob.busy} onclick={deleteTts} />
        {/if}
      </div>
      {#if ttsError}<p class="err-text" role="alert">{ttsError}</p>{/if}
      {#if !tts.modelReady || showTtsDownloads || ttsJob.busy}
        <div class="fit" use:fit>
          <Btn icon="download" label="Download kokoro-v1.0.onnx" short="Model" p={1} class="primary" title={ttsJob.busy ? 'Another TTS download is running' : 'Download the Kokoro speech model (about 310 MB)'} disabled={ttsJob.busy} onclick={() => downloadTts(tts!.defaultModelUrl)} />
          <Btn icon="download" label="Download voices-v1.0.bin" short="Voices" title={ttsJob.busy ? 'Another TTS download is running' : 'Download the 54 built-in Kokoro voices (about 27 MB)'} disabled={ttsJob.busy} onclick={() => downloadTts(tts!.defaultVoicesUrl)} />
        </div>
        <div class="fit" use:fit>
          <input class="grow mono" aria-label="Other TTS file link" title="Direct link to another Kokoro .onnx model or voices .bin file" bind:value={ttsUrl} placeholder="Other TTS file URL (.onnx / .bin)" disabled={ttsJob.busy} spellcheck="false" />
          {#if ttsJob.busy}
            <Btn icon="x" label="Cancel" title="Stop; the partial download resumes next time" onclick={() => ttsJob.cancel()} />
          {:else}
            <Btn icon="download" label="Download" title={ttsUrl.trim() ? 'Download this file into the TTS folder' : 'Paste a link first'} onclick={() => downloadTts(ttsUrl)} disabled={!ttsUrl.trim()} />
          {/if}
        </div>
      {/if}
    {/if}
    <JobStatus job={ttsJob} text={progressText(ttsJob.progress)} />
  </div>

  {#if featured.length}
    <div class="card">
      <div class="card-h"><h2>Featured language packs</h2></div>
      <div class="packcards">
        {#each featured as f (f.id)}
          {@const job = featuredJob(f.id)}
          <article class="packcard">
            <div class="hd">{@render flag(f.language)}<span class="nm">{f.name}</span></div>
            <div class="meta">
              <span class="badge outline">{formatBytes(f.totalSize)}</span>
              <span class="badge outline">{f.license}</span>
              <code class="help src" title="Source">{f.source}</code>
            </div>
            <div class="ft">
              {#if f.installed}
                <span class="badge ok" title="Already installed; delete it in the pack list below to reinstall"><Icon name="check" />Installed</span>
              {:else if job.busy}
                <Btn icon="x" label="Cancel" title="Stop the install and remove the partial pack" onclick={() => job.cancel()} />
              {:else}
                <Btn icon="download" label="Install" class="primary" title={`Download ${formatBytes(f.totalSize)} and install this pack; its voice then appears in the voice picker`} onclick={() => installFeatured(f)} />
              {/if}
            </div>
            <JobStatus {job} text={progressText(job.progress)} />
          </article>
        {/each}
      </div>
    </div>
  {/if}

  <div class="card">
    <div class="card-h"><h2>Add model or voice from link</h2></div>
    <p class="help">
      Paste a HuggingFace link or any direct URL. Voice files (.pt, .npy, .npz, .bin, max 50 MB) are added to the base
      model; the voice id is the file name without extension, e.g. <code>af_custom</code>. A Kokoro fine-tune model
      (.onnx, max 1 GB) becomes a language pack with its own voices. PyTorch checkpoints (.pth, .safetensors) are not
      supported.
    </p>
    <div class="fit" use:fit>
      <input
        class="grow mono"
        aria-label="Voice or model link"
        title="Link to a voice file or an ONNX model"
        bind:value={voiceUrl}
        placeholder="https://huggingface.co/hexgrad/Kokoro-82M/blob/main/voices/af_heart.pt"
        disabled={voiceJob.busy}
        spellcheck="false"
      />
      {#if voiceJob.busy}
        <Btn icon="x" label="Cancel" title="Stop downloading this voice" onclick={() => voiceJob.cancel()} />
      {:else}
        <Btn icon="plus" label="Add" title={voiceUrl.trim() ? 'Voice files install directly; an .onnx model opens the language pack dialog' : 'Paste a link first'} onclick={addFromLink} disabled={!voiceUrl.trim() || linkChecking} />
      {/if}
    </div>
    <JobStatus job={voiceJob} text={progressText(voiceJob.progress)} />
  </div>

  <div class="card">
    <div class="card-h">
      <h2>Installed language packs</h2>
      <span class="badge">{packs.length ? `${packs.length} installed` : 'None'}</span>
    </div>
    {#if packs.length}
      <div class="list">
        {#each packs as p (p.id)}
          {@const lang = languageInfo(p.language)}
          <div class="item col">
            <div class="row">
              {@render flag(p.language)}
              <span class="txt">
                <span class="n">{p.name}</span>
                <span class="s">{lang?.name ?? p.language} · {p.voices.map((v) => v.replace(/\.[^.]+$/, '')).join(', ')}</span>
              </span>
              <div class="fit" use:fit>
                <Btn icon="plus" label="Add voice to this pack" short="Add voice" p={1} title={packVoiceJob.busy ? 'Wait for the current voice download' : `Add another voice file to ${p.name}`} disabled={packVoiceJob.busy} onclick={() => (packVoiceFor = packVoiceFor === p.id ? null : p.id)} />
                <Btn icon="trash" label="Delete pack" short="Delete" class="danger" title={packVoiceJob.busy ? 'Wait for the current voice download' : `Delete ${p.name} with its model and voices (asks for confirmation)`} disabled={packVoiceJob.busy} onclick={() => removePack(p)} />
              </div>
            </div>
            {#if packVoiceFor === p.id}
              <div class="fit" use:fit>
                <input class="grow mono" aria-label={`Voice link for ${p.name}`} title="Link to a voice file (.pt, .npy, .npz, .bin) for this pack" bind:value={packVoiceUrl} placeholder="Voice link (.pt, .npy, .npz, .bin)" disabled={packVoiceJob.busy} spellcheck="false" />
                {#if packVoiceJob.busy}
                  <Btn icon="x" label="Cancel" title="Stop downloading this voice" onclick={() => packVoiceJob.cancel()} />
                {:else}
                  <Btn icon="download" label="Download" class="primary" title={packVoiceUrl.trim() ? 'Download the voice into this pack and restart speech' : 'Paste a voice link first'} onclick={() => addPackVoice(p.id)} disabled={!packVoiceUrl.trim()} />
                {/if}
              </div>
              <JobStatus job={packVoiceJob} text={progressText(packVoiceJob.progress)} />
            {/if}
          </div>
        {/each}
      </div>
    {:else}
      <div class="empty-inline">No language packs installed. Install a featured pack above or add an .onnx link.</div>
    {/if}
  </div>

  <div class="card">
    <div class="card-h"><h2>Custom voices</h2></div>
    {#if customVoices.length}
      <div class="list">
        {#each customVoices as v (v.name)}
          <div class="item">
            <span class="ic"><Icon name="file" /></span>
            <span class="txt"><span class="n mono">{v.name}</span></span>
            <span class="size">{formatBytes(v.size)}</span>
            <button type="button" class="icon-only ghost danger" title={voiceJob.busy ? 'Wait for the current download' : `Delete voice file ${v.name} (asks for confirmation)`} aria-label={`Delete voice ${v.name}`} disabled={voiceJob.busy} onclick={() => removeVoice(v.name)}><Icon name="trash" /></button>
          </div>
        {/each}
      </div>
    {:else}
      <div class="empty-inline">No custom voices. Paste a voice link above to add one.</div>
    {/if}
  </div>
{/if}

{#if packDialog}
  <PackDialog modelUrl={packDialog.url} info={packDialog.info} onClose={() => (packDialog = null)} onCreated={packCreated} />
{/if}

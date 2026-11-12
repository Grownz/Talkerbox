<script lang="ts">
  import { api, progressText, type LinkInfo } from './api'
  import Icon from './Icon.svelte'
  import { Job } from './job.svelte'
  import JobStatus from './JobStatus.svelte'
  import { ESPEAK, languageInfo } from './voices'

  let {
    modelUrl,
    info,
    onClose,
    onCreated,
  }: { modelUrl: string; info: LinkInfo; onClose: () => void; onCreated: () => void } = $props()

  // svelte-ignore state_referenced_locally (initial suggestions only)
  let name = $state(info.name)
  // svelte-ignore state_referenced_locally
  let language = $state(info.languages.find((c) => languageInfo(c)) ?? '')
  let vocabUrl = $state('')
  let voiceUrls = $state('')
  const job = new Job()
  const langName = $derived(languageInfo(language)?.name)

  async function create() {
    const ok = await job.run(
      (id, p) =>
        api.createPack(
          id,
          {
            name,
            language,
            modelUrl,
            vocabUrl: vocabUrl.trim() || null,
            voiceUrls: voiceUrls.split(/\s+/).filter(Boolean),
          },
          p,
        ),
      'Language pack installed.',
    )
    if (ok) onCreated()
  }
</script>

<div class="scrim">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="pack-title">
    <div class="dlg-head">
      <span class="ico acc"><Icon name="globe" /></span>
      <h2 id="pack-title">New language pack</h2>
    </div>
    <div class="dlg-body">
      <p>Kokoro ONNX fine-tune: <code class="break">{modelUrl}</code>. Everything is downloaded into its own pack folder.</p>
      <label class="field">
        <span class="label">Pack name</span>
        <input title="Name shown in the voice picker and pack list" bind:value={name} disabled={job.busy} />
      </label>
      <label class="field">
        <span class="label">Language (espeak-ng code) <span class="muted">{langName ?? (language ? 'unknown code' : '')}</span></span>
        <input class="mono" title="espeak-ng code used to turn text into phonemes, e.g. de or pt-br" bind:value={language} list="espeak-codes" placeholder="e.g. de" disabled={job.busy} spellcheck="false" />
      </label>
      <datalist id="espeak-codes">
        {#each Object.entries(ESPEAK) as [code, l] (code)}<option value={code}>{l.name}</option>{/each}
      </datalist>
      <label class="field">
        <span class="label">Vocab JSON link <span class="muted">(optional)</span></span>
        <input class="mono" title="Only needed if the model uses a different phoneme vocabulary" bind:value={vocabUrl} placeholder="https://…/vocab.json" disabled={job.busy} spellcheck="false" />
      </label>
      <label class="field">
        <span class="label">Voice links (.pt, .npy, .npz, .bin), one per line</span>
        <textarea class="mono" title="At least one voice file link; one per line" bind:value={voiceUrls} rows="3" disabled={job.busy} spellcheck="false"></textarea>
      </label>
      <JobStatus {job} text={progressText(job.progress)} />
    </div>
    <div class="dlg-foot">
      {#if job.busy}
        <button type="button" title="Stop and remove the partially installed pack" onclick={() => job.cancel()}><Icon name="x" />Cancel download</button>
      {:else}
        <button type="button" title="Close without installing" onclick={onClose}>Close</button>
        <button type="button" class="primary" title={!name.trim() || !language.trim() || !voiceUrls.trim() ? 'Enter a name, a language and at least one voice link first' : 'Download the model and voices and install the pack'} onclick={create} disabled={!name.trim() || !language.trim() || !voiceUrls.trim()}><Icon name="download" />Download & install</button>
      {/if}
    </div>
  </div>
</div>

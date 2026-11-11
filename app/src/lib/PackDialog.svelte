<script lang="ts">
  import { api, progressText, type LinkInfo } from './api'
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

<div class="modal-backdrop">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="pack-title">
    <h2 id="pack-title">New language pack</h2>
    <p class="muted">
      Kokoro ONNX fine-tune: <code>{modelUrl}</code>. Everything is downloaded into its own pack folder.
    </p>
    <label>Pack name <input title="Name shown in the voice picker and pack list" bind:value={name} disabled={job.busy} /></label>
    <label>
      Language (espeak-ng code)
      <input title="espeak-ng code used to turn text into phonemes, e.g. de or pt-br" bind:value={language} list="espeak-codes" placeholder="e.g. de" disabled={job.busy} />
      <span class="muted">{langName ?? (language ? 'unknown code' : '')}</span>
    </label>
    <datalist id="espeak-codes">
      {#each Object.entries(ESPEAK) as [code, l] (code)}<option value={code}>{l.name}</option>{/each}
    </datalist>
    <label>Vocab JSON link (optional) <input title="Only needed if the model uses a different phoneme vocabulary" bind:value={vocabUrl} placeholder="https://…/vocab.json" disabled={job.busy} /></label>
    <label class="stack">
      Voice links (.pt, .npy, .npz, .bin), one per line
      <textarea title="At least one voice file link; one per line" bind:value={voiceUrls} rows="3" disabled={job.busy}></textarea>
    </label>
    <JobStatus {job} text={progressText(job.progress)} />
    <div class="row end">
      {#if job.busy}
        <button title="Stop and remove the partially installed pack" onclick={() => job.cancel()}>Cancel download</button>
      {:else}
        <button class="ghost" title="Close without installing" onclick={onClose}>Close</button>
        <button title={!name.trim() || !language.trim() || !voiceUrls.trim() ? 'Enter a name, a language and at least one voice link first' : 'Download the model and voices and install the pack'} onclick={create} disabled={!name.trim() || !language.trim() || !voiceUrls.trim()}>Download & install</button>
      {/if}
    </div>
  </div>
</div>

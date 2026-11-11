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
    <label>Pack name <input bind:value={name} disabled={job.busy} /></label>
    <label>
      Language (espeak-ng code)
      <input bind:value={language} list="espeak-codes" placeholder="e.g. de" disabled={job.busy} />
      <span class="muted">{langName ?? (language ? 'unknown code' : '')}</span>
    </label>
    <datalist id="espeak-codes">
      {#each Object.entries(ESPEAK) as [code, l] (code)}<option value={code}>{l.name}</option>{/each}
    </datalist>
    <label>Vocab JSON link (optional) <input bind:value={vocabUrl} placeholder="https://…/vocab.json" disabled={job.busy} /></label>
    <label class="stack">
      Voice links (.pt, .npy, .npz, .bin), one per line
      <textarea bind:value={voiceUrls} rows="3" disabled={job.busy}></textarea>
    </label>
    <JobStatus {job} text={progressText(job.progress)} />
    <div class="row end">
      {#if job.busy}
        <button onclick={() => job.cancel()}>Cancel download</button>
      {:else}
        <button class="ghost" onclick={onClose}>Close</button>
        <button onclick={create} disabled={!name.trim() || !language.trim() || !voiceUrls.trim()}>Download & install</button>
      {/if}
    </div>
  </div>
</div>

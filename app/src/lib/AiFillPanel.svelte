<script lang="ts">
  // "Fill (AI)" controls in the part editor: LaMa model status (download with progress/cancel, remove with size) and
  // "Generate with AI". The model is loaded, run and freed in one backend call, so there is nothing to release here
  // except a running download.
  import { onMount } from 'svelte'
  import { generateAiFill, type AiFill } from './aiFill'
  import { api, formatBytes, progressText } from './api'
  import Icon from './Icon.svelte'
  import { ModelStatus } from './modelStatus.svelte'
  import type { Point } from './rig'

  let {
    image,
    polys,
    state: fillState,
    onResult,
  }: {
    /** The decoded character image and its size (read when generating). */
    image: () => { bitmap: ImageBitmap | null; W: number; H: number }
    polys: Point[][]
    state: 'none' | 'stale' | 'ready'
    onResult: (r: AiFill) => void
  } = $props()

  const model = new ModelStatus({ status: api.inpaintStatus, download: api.inpaintDownload, remove: api.inpaintRemove })
  let info = $state('')

  async function generate() {
    const { bitmap, W, H } = image()
    if (!bitmap) return
    await model.run(async () => {
      const r = await generateAiFill(bitmap, W, H, polys)
      info = `Generated in ${(r.ms / 1000).toFixed(1)} s.`
      onResult(r)
    })
  }
  const remove = () =>
    model.remove(
      `Delete the AI fill model (${formatBytes(model.bytes)})? Fills you already generated stay with your characters; generating a new one needs the download again (about 93 MB).`,
      'Remove AI fill model',
    )

  onMount(() => {
    void model.refresh()
    return () => model.cancel()
  })
</script>

<div class="aifill" role="group" aria-label="AI fill">
  {#if model.status === 'ready' || model.status === 'busy'}
    <button type="button" class="sm primary" disabled={model.status === 'busy' || !polys.length} title="Fill the area under arms, hands and legs with the AI model (takes about 10 s)" onclick={generate}
      ><Icon name="wand" />{model.status === 'busy' ? 'Generating…' : fillState === 'ready' ? 'Generate again' : 'Generate with AI'}</button
    >
    <button type="button" class="icon-only sm ghost" title={`Remove the AI fill model from this computer (${formatBytes(model.bytes)}, asks first)`} aria-label="Remove AI fill model" onclick={remove}
      ><Icon name="trash" /></button
    >
    <span class="help">
      {info || (fillState === 'ready' ? 'AI fill ready; it is saved with the character.' : fillState === 'stale' ? 'The parts changed since the AI fill was made: generate it again.' : 'Not generated yet: the classic fill is shown.')}
    </span>
  {:else if model.status === 'downloading'}
    <span class="help">{progressText(model.progress) || 'Starting download…'}</span>
    <button type="button" class="sm" onclick={() => model.cancel()}><Icon name="x" />Cancel</button>
  {:else if model.status === 'missing' || model.status === 'error'}
    {#if model.status === 'error'}<span class="help err-text">{model.err}</span>{/if}
    <span class="help">
      The AI fill needs a one-time download of about {model.runtime ? '93' : '108'} MB (LaMa model{model.runtime ? '' : ' and ONNX Runtime'}); after that it works offline.
    </span>
    <button type="button" class="sm" onclick={() => model.download()}><Icon name="download" />Download</button>
  {:else}
    <span class="help">Checking the AI fill model…</span>
  {/if}
</div>

<style>
  .aifill {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
  }
  .help {
    flex: 1 1 100%;
  }
</style>

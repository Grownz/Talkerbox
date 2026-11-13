<script lang="ts">
  // "Fill (AI)" controls in the part editor: LaMa model status (download with progress/cancel, remove with size) and
  // "Generate with AI". The model is loaded, run and freed in one backend call, so there is nothing to release here
  // except a running download.
  import { ask } from '@tauri-apps/plugin-dialog'
  import { onMount } from 'svelte'
  import { generateAiFill, type AiFill } from './aiFill'
  import { api, errText, formatBytes, newOpId, progressText, type Progress } from './api'
  import Icon from './Icon.svelte'
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

  let status = $state<'unknown' | 'missing' | 'downloading' | 'ready' | 'busy' | 'error'>('unknown')
  let err = $state('')
  let info = $state('')
  let bytes = $state(0)
  let runtime = $state(false)
  let progress = $state<Progress | null>(null)
  let op: string | null = null

  async function refresh() {
    try {
      const s = await api.inpaintStatus()
      bytes = s.bytes
      runtime = s.runtime
      status = s.installed ? 'ready' : 'missing'
    } catch (e) {
      status = 'error'
      err = errText(e)
    }
  }
  async function download() {
    const id = (op = newOpId())
    status = 'downloading'
    err = ''
    progress = null
    try {
      await api.inpaintDownload(id, (p) => (progress = p))
    } catch (e) {
      err = `Download failed: ${errText(e)}`
    }
    op = null
    await refresh()
    if (err) status = 'error'
  }
  async function generate() {
    const { bitmap, W, H } = image()
    if (!bitmap) return
    status = 'busy'
    err = ''
    try {
      const r = await generateAiFill(bitmap, W, H, polys)
      info = `Generated in ${(r.ms / 1000).toFixed(1)} s.`
      onResult(r)
      status = 'ready'
    } catch (e) {
      status = 'error'
      err = errText(e)
    }
  }
  async function remove() {
    const ok = await ask(`Delete the AI fill model (${formatBytes(bytes)})? Fills you already generated stay with your characters; generating a new one needs the download again (about 93 MB).`, {
      title: 'Remove AI fill model',
      kind: 'warning',
      okLabel: 'Remove',
      cancelLabel: 'Keep',
    })
    if (!ok) return
    try {
      await api.inpaintRemove()
    } catch (e) {
      err = `Removing failed: ${errText(e)}`
    }
    await refresh()
  }

  onMount(() => {
    void refresh()
    return () => {
      if (op) void api.cancel(op)
    }
  })
</script>

<div class="aifill" role="group" aria-label="AI fill">
  {#if status === 'ready' || status === 'busy'}
    <button type="button" class="sm primary" disabled={status === 'busy' || !polys.length} title="Fill the area under arms, hands and legs with the AI model (takes about 10 s)" onclick={generate}
      ><Icon name="wand" />{status === 'busy' ? 'Generating…' : fillState === 'ready' ? 'Generate again' : 'Generate with AI'}</button
    >
    <button type="button" class="icon-only sm ghost" title={`Remove the AI fill model from this computer (${formatBytes(bytes)}, asks first)`} aria-label="Remove AI fill model" onclick={remove}
      ><Icon name="trash" /></button
    >
    <span class="help">
      {info || (fillState === 'ready' ? 'AI fill ready; it is saved with the character.' : fillState === 'stale' ? 'The parts changed since the AI fill was made: generate it again.' : 'Not generated yet: the classic fill is shown.')}
    </span>
  {:else if status === 'downloading'}
    <span class="help">{progressText(progress) || 'Starting download…'}</span>
    <button type="button" class="sm" onclick={() => op && api.cancel(op)}><Icon name="x" />Cancel</button>
  {:else if status === 'missing' || status === 'error'}
    {#if status === 'error'}<span class="help err-text">{err}</span>{/if}
    <span class="help">
      The AI fill needs a one-time download of about {runtime ? '93' : '108'} MB (LaMa model{runtime ? '' : ' and ONNX Runtime'}); after that it works offline.
    </span>
    <button type="button" class="sm" onclick={download}><Icon name="download" />Download</button>
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

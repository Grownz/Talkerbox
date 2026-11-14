<script lang="ts">
  // "Detect face" in the part editor: face model status (download with progress/cancel, remove with size) and the
  // detect button. The models are loaded, run and freed in one backend call (src-tauri/src/face.rs), so there is
  // nothing to release here except a running download.
  import { onMount } from 'svelte'
  import { api, formatBytes, progressText } from './api'
  import Icon from './Icon.svelte'
  import { ModelStatus } from './modelStatus.svelte'
  import type { Point } from './rig'
  import { encodeSize } from './smartSelect'

  let {
    image,
    disabled,
    onResult,
  }: {
    /** The decoded character image and its size (read when detecting). */
    image: () => { bitmap: ImageBitmap | null; W: number; H: number }
    disabled: boolean
    onResult: (points: Point[]) => void
  } = $props()

  const model = new ModelStatus({ status: api.faceStatus, download: api.faceDownload, remove: api.faceRemove })

  async function detect() {
    const { bitmap, W, H } = image()
    if (!bitmap) return
    const [w, h] = encodeSize(W, H)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.imageSmoothingQuality = 'high'
    g.drawImage(bitmap, 0, 0, w, h)
    await model.run(async () => onResult((await api.faceDetect(g.getImageData(0, 0, w, h).data, w, h)).points))
  }
  async function remove() {
    const removed = await model.remove(
      `Delete the face detection models (${formatBytes(model.bytes)})? Detecting faces again needs the download again (about 5 MB).`,
      'Remove face detection models',
    )
    if (removed && model.err) model.status = 'error'
  }

  onMount(() => {
    void model.refresh()
    return () => model.cancel()
  })
</script>

<div class="face" role="group" aria-label="Detect face">
  {#if model.status === 'downloading'}
    <span class="help">{progressText(model.progress) || 'Starting download…'}</span>
    <button type="button" class="sm" onclick={() => model.cancel()}><Icon name="x" />Cancel</button>
  {:else if model.status === 'missing' || (model.status === 'error' && model.err.startsWith('Download'))}
    {#if model.status === 'error'}<span class="help err-text">{model.err}</span>{/if}
    <span class="help">
      Face detection needs a one-time download of about {model.runtime ? '5' : '20'} MB (MediaPipe face models{model.runtime ? '' : ' and ONNX Runtime'}); after that it works offline.
    </span>
    <button type="button" class="sm" onclick={() => model.download()}><Icon name="download" />Download</button>
  {:else if model.status === 'unknown'}
    <span class="help">Checking the face detection models…</span>
  {:else}
    <button
      type="button"
      class="sm primary"
      disabled={disabled || model.status === 'busy'}
      title="Find the face and add both eyes and the mouth with lips as parts (one undo step). Made for photos and realistic paintings."
      onclick={detect}><Icon name="user" />{model.status === 'busy' ? 'Detecting…' : 'Detect eyes and mouth'}</button
    >
    <button type="button" class="icon-only sm ghost" title={`Remove the face detection models from this computer (${formatBytes(model.bytes)}, asks first)`} aria-label="Remove face detection models" onclick={remove}
      ><Icon name="trash" /></button
    >
    <span class="help" class:err-text={model.status === 'error'}>
      {model.status === 'error' ? model.err : 'For photos and realistic paintings. On cartoons the face is often not found, or the eyes come out too flat: use Pick there.'}
    </span>
  {/if}
</div>

<style>
  .face {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
  }
  .help {
    flex: 1 1 100%;
  }
</style>

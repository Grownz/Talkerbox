<script lang="ts">
  // "Detect face" in the part editor: face model status (download with progress/cancel, remove with size) and the
  // detect button. The models are loaded, run and freed in one backend call (src-tauri/src/face.rs), so there is
  // nothing to release here except a running download.
  import { ask } from '@tauri-apps/plugin-dialog'
  import { onMount } from 'svelte'
  import { api, errText, formatBytes, newOpId, progressText, type Progress } from './api'
  import Icon from './Icon.svelte'
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

  let status = $state<'unknown' | 'missing' | 'downloading' | 'ready' | 'busy' | 'error'>('unknown')
  let err = $state('')
  let bytes = $state(0)
  let runtime = $state(false)
  let progress = $state<Progress | null>(null)
  let op: string | null = null

  async function refresh() {
    try {
      const s = await api.faceStatus()
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
      await api.faceDownload(id, (p) => (progress = p))
    } catch (e) {
      err = `Download failed: ${errText(e)}`
    }
    op = null
    await refresh()
    if (err) status = 'error'
  }
  async function detect() {
    const { bitmap, W, H } = image()
    if (!bitmap) return
    status = 'busy'
    err = ''
    const [w, h] = encodeSize(W, H)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.imageSmoothingQuality = 'high'
    g.drawImage(bitmap, 0, 0, w, h)
    try {
      onResult((await api.faceDetect(g.getImageData(0, 0, w, h).data, w, h)).points)
      status = 'ready'
    } catch (e) {
      status = 'error'
      err = errText(e)
    }
  }
  async function remove() {
    const ok = await ask(`Delete the face detection models (${formatBytes(bytes)})? Detecting faces again needs the download again (about 5 MB).`, {
      title: 'Remove face detection models',
      kind: 'warning',
      okLabel: 'Remove',
      cancelLabel: 'Keep',
    })
    if (!ok) return
    try {
      await api.faceRemove()
    } catch (e) {
      err = `Removing failed: ${errText(e)}`
    }
    await refresh()
    if (err) status = 'error'
  }

  onMount(() => {
    void refresh()
    return () => {
      if (op) void api.cancel(op)
    }
  })
</script>

<div class="face" role="group" aria-label="Detect face">
  {#if status === 'downloading'}
    <span class="help">{progressText(progress) || 'Starting download…'}</span>
    <button type="button" class="sm" onclick={() => op && api.cancel(op)}><Icon name="x" />Cancel</button>
  {:else if status === 'missing' || (status === 'error' && err.startsWith('Download'))}
    {#if status === 'error'}<span class="help err-text">{err}</span>{/if}
    <span class="help">
      Face detection needs a one-time download of about {runtime ? '5' : '20'} MB (MediaPipe face models{runtime ? '' : ' and ONNX Runtime'}); after that it works offline.
    </span>
    <button type="button" class="sm" onclick={download}><Icon name="download" />Download</button>
  {:else if status === 'unknown'}
    <span class="help">Checking the face detection models…</span>
  {:else}
    <button
      type="button"
      class="sm primary"
      disabled={disabled || status === 'busy'}
      title="Find the face and add both eyes and the mouth with lips as parts (one undo step). Made for photos and realistic paintings."
      onclick={detect}><Icon name="user" />{status === 'busy' ? 'Detecting…' : 'Detect eyes and mouth'}</button
    >
    <button type="button" class="icon-only sm ghost" title={`Remove the face detection models from this computer (${formatBytes(bytes)}, asks first)`} aria-label="Remove face detection models" onclick={remove}
      ><Icon name="trash" /></button
    >
    <span class="help" class:err-text={status === 'error'}>
      {status === 'error' ? err : 'For photos and realistic paintings. On cartoons the face is often not found, or the eyes come out too flat: use Pick there.'}
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

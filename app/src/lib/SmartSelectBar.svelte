<script lang="ts">
  // Controls of a smart select session (smartSession.svelte.ts): accept the proposal, clear the points, remove the
  // model, or download / cancel / retry. Shared by the mask editor and the part editor.
  import { progressText } from './api'
  import Icon from './Icon.svelte'
  import type { SmartSession } from './smartSession.svelte'

  let { s, acceptLabel, acceptTitle, onAccept }: { s: SmartSession; acceptLabel: string; acceptTitle: string; onAccept: () => void } = $props()
</script>

<div class="smart" role="group" aria-label="Smart select">
  {#if s.status === 'ready'}
    <button type="button" class="sm primary" disabled={!s.proposal} title={acceptTitle} onclick={onAccept}><Icon name="check" />{acceptLabel}</button>
    <button type="button" class="sm" disabled={!s.prompts.length} title="Remove all points and the box (Esc)" onclick={() => s.clear()}><Icon name="x" />Clear points</button>
    <span class="help" class:err-text={!!s.err}>{s.err || s.info}</span>
    <button type="button" class="icon-only sm ghost" title="Remove the smart select model from this computer (asks first)" aria-label="Remove smart select model" onclick={() => s.remove()}
      ><Icon name="trash" /></button
    >
  {:else if s.status === 'downloading'}
    <span class="help">{progressText(s.progress) || 'Starting download…'}</span>
    <button type="button" class="sm" onclick={() => s.cancel()}><Icon name="x" />Cancel</button>
  {:else if s.status === 'missing' || s.status === 'error'}
    <span class="help" class:err-text={s.status === 'error'}
      >{s.status === 'error' ? s.err : 'Smart select needs a one-time download of about 60 MB (MobileSAM model and ONNX Runtime); after that it works offline.'}</span
    >
    <button type="button" class="sm" onclick={() => (s.status === 'error' ? s.retry() : s.download())}
      ><Icon name={s.status === 'error' ? 'refresh' : 'download'} />{s.status === 'error' ? 'Retry' : 'Download'}</button
    >
  {:else}
    <span class="help">Analysing the image…</span>
  {/if}
</div>

<style>
  .smart {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 8px;
    flex: 2 1 320px;
    min-width: 0;
  }
  .help {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

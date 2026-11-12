<script lang="ts">
  import { open } from '@tauri-apps/plugin-dialog'
  import { api, errText } from './api'
  import Icon from './Icon.svelte'

  let { current, onClose, onSaved }: { current: string | null; onClose: () => void; onSaved: (exe: string) => void } = $props()

  // svelte-ignore state_referenced_locally (only the initial value is wanted)
  let path = $state(current ?? '')
  let error = $state('')

  async function browse(directory: boolean) {
    const picked = await open(
      directory
        ? { directory: true, title: 'Select the Ollama install folder' }
        : { title: 'Select ollama.exe', filters: [{ name: 'Ollama', extensions: ['exe'] }] },
    )
    if (typeof picked === 'string') path = picked
  }

  async function save() {
    error = ''
    try {
      onSaved(await api.setOllamaPath(path))
    } catch (e) {
      error = errText(e)
    }
  }
</script>

<div class="scrim">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="path-title">
    <div class="dlg-head">
      <span class="ico acc"><Icon name="folder" /></span>
      <h2 id="path-title">Locate Ollama</h2>
      <button type="button" class="icon-only ghost" title="Close without changing the path" aria-label="Close" onclick={onClose}><Icon name="x" /></button>
    </div>
    <div class="dlg-body">
      <p>
        Talkerbox uses a locally installed Ollama and never installs it. If Ollama is installed somewhere unusual, pick
        <code>ollama.exe</code> or its folder. Get Ollama from <code>ollama.com</code> if it is not installed.
      </p>
      <label class="field">
        <span class="label">Path to ollama.exe or its folder</span>
        <input class="mono" title="Path to ollama.exe or the folder that contains it" bind:value={path} placeholder="C:\Users\you\AppData\Local\Programs\Ollama" spellcheck="false" />
      </label>
      <div class="row">
        <button type="button" title="Pick the Ollama install folder" onclick={() => browse(true)}><Icon name="folder" />Browse folder…</button>
        <button type="button" title="Pick ollama.exe directly" onclick={() => browse(false)}><Icon name="file" />Browse exe…</button>
      </div>
      {#if error}<p class="err-text" role="alert">{error}</p>{/if}
    </div>
    <div class="dlg-foot">
      <button type="button" title="Close without changing the path" onclick={onClose}>Cancel</button>
      <button type="button" class="primary" title={path.trim() ? 'Check this path and remember it' : 'Enter or browse to a path first'} disabled={!path.trim()} onclick={save}><Icon name="check" />Save</button>
    </div>
  </div>
</div>

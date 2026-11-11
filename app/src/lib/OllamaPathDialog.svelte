<script lang="ts">
  import { open } from '@tauri-apps/plugin-dialog'
  import { api, errText } from './api'

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

<div class="modal-backdrop">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="path-title">
    <h2 id="path-title">Locate Ollama</h2>
    <p>
      Talkerbox uses a locally installed Ollama and never installs it. If Ollama is installed somewhere unusual, pick
      <code>ollama.exe</code> or its folder. Get Ollama from <code>ollama.com</code> if it is not installed.
    </p>
    <label>
      Path
      <input title="Path to ollama.exe or the folder that contains it" bind:value={path} placeholder="C:\Users\you\AppData\Local\Programs\Ollama" />
    </label>
    <div class="row">
      <button class="ghost" title="Pick the Ollama install folder" onclick={() => browse(true)}>Browse folder…</button>
      <button class="ghost" title="Pick ollama.exe directly" onclick={() => browse(false)}>Browse exe…</button>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="row end">
      <button class="ghost" title="Close without changing the path" onclick={onClose}>Cancel</button>
      <button title={path.trim() ? 'Check this path and remember it' : 'Enter or browse to a path first'} disabled={!path.trim()} onclick={save}>Save</button>
    </div>
  </div>
</div>

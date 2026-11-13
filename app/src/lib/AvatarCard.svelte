<script lang="ts" module>
  import { Speaker } from './speaker'
  // One speaker for the test button, shared by every mount of the card (one AudioContext). Its own avatar source id,
  // so stopping it never clears the mouth of a reply the chat speaker is reading out, and the other way round.
  const testSpeaker = new Speaker('test')
  const SAMPLE = 'Hello! This is how your avatar looks while it speaks.'
</script>

<script lang="ts">
  // Avatar page cards: avatar window switch with its background options, the saved characters and the smart select model.
  import { ask, open } from '@tauri-apps/plugin-dialog'
  import { onMount } from 'svelte'
  import { api, errText, formatBytes, type Settings } from './api'
  import { avatar, puppetOpen, sendToPuppet, toggleAvatar } from './avatar.svelte'
  import Btn from './Btn.svelte'
  import type { AvatarSentence } from './avatarQueue'
  import { testEnvelope } from './envelope'
  import { testVisemes } from './viseme'
  import { fit } from './fit'
  import Icon from './Icon.svelte'
  import MaskEditor from './MaskEditor.svelte'
  import PartEditor from './PartEditor.svelte'
  import { maskOutline, type Rig } from './rig'

  let { settings = $bindable(), onError }: { settings: Settings; onError: (msg: string) => void } = $props()

  let characters = $state<Rig[]>([])
  let thumbs = $state<Record<string, string>>({})
  let importing = $state(false)
  let editing = $state<Rig | null>(null)
  let editingParts = $state<Rig | null>(null)

  // The thumbnail shows the cut-out: the image keeps its aspect ratio, so the 0..1 mask maps onto its own box.
  const clip = (c: Rig) => {
    const o = maskOutline(c)
    return o ? `polygon(${o.map(([x, y]) => `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`).join(',')})` : undefined
  }

  const facts = (c: Rig) =>
    `${c.image.width} x ${c.image.height} px · ${maskOutline(c) ? 'Cut out' : 'No mask'} · ${
      c.parts.length ? `${c.parts.length} ${c.parts.length === 1 ? 'part' : 'parts'}` : 'No parts yet: the figure only sways'
    }`

  async function maskSaved() {
    await refresh()
    avatar.rev++ // the avatar window reloads the character
  }

  // shortcut: thumbnails decode the full image (max 20 MB each); store a small preview if lists get long.
  async function refresh() {
    try {
      characters = await api.avatarList()
      const old = thumbs
      const next: Record<string, string> = {}
      for (const c of characters) next[c.id] = old[c.id] ?? URL.createObjectURL(await api.avatarImage(c))
      for (const [id, url] of Object.entries(old)) if (!next[id]) URL.revokeObjectURL(url)
      thumbs = next
      if (settings.avatarActive && !characters.some((c) => c.id === settings.avatarActive)) settings.avatarActive = null
    } catch (e) {
      onError(`Loading characters failed: ${errText(e)}`)
    }
  }

  // Smart select model (mask editor): installed state and size on disk; refreshed when a mask editor closes.
  let sam = $state<{ installed: boolean; bytes: number } | null>(null)
  let samBusy = $state(false)
  const samRefresh = () => api.samStatus().then((s) => (sam = s), (e) => onError(errText(e)))
  async function samRemove() {
    if (!sam) return
    const ok = await ask(`Delete the smart select model and runtime (${formatBytes(sam.bytes)})? Using smart select again needs a new download of about 60 MB.`, {
      title: 'Remove smart select model',
      kind: 'warning',
      okLabel: 'Remove',
      cancelLabel: 'Keep',
    })
    if (!ok) return
    samBusy = true
    try {
      await api.samRemove()
    } catch (e) {
      onError(`Removing the smart select model failed: ${errText(e)}`)
    } finally {
      samBusy = false
      await samRefresh()
    }
  }

  onMount(() => {
    void refresh()
    void samRefresh()
    return () => Object.values(thumbs).forEach((u) => URL.revokeObjectURL(u))
  })

  async function importImage() {
    const path = await open({ title: 'Choose a character image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
    if (typeof path !== 'string') return
    importing = true
    try {
      const rig = await api.avatarImportImage(path)
      await refresh()
      settings.avatarActive = rig.id
    } catch (e) {
      onError(`Import failed: ${errText(e)}`)
    } finally {
      importing = false
    }
  }

  let testing = $state(false)
  /** Speaks a sample sentence (or, without running speech, plays a silent loudness pattern) so the avatar moves. */
  async function testSpeech() {
    testSpeaker.unlock() // within the click, so audio may play
    testing = true
    try {
      if (!avatar.open) {
        await puppetOpen(settings.avatarBg === 'transparent')
        for (let i = 0; i < 50 && !avatar.open; i++) await new Promise((r) => setTimeout(r, 100))
      }
      const tts = await api.ttsStatus().catch(() => null)
      if (tts?.running && settings.voice) {
        testSpeaker.onError = onError
        testSpeaker.onSpeaking = (on) => void api.sttMute(on).catch(() => {})
        testSpeaker.stop()
        testSpeaker.voice = settings.voice
        testSpeaker.speed = settings.ttsSpeed
        testSpeaker.feed(SAMPLE)
        testSpeaker.flush()
      } else {
        const envelope = testEnvelope(3000)
        const msg: AvatarSentence = {
          startMs: performance.timeOrigin + performance.now() + 100,
          hopMs: 20,
          envelope,
          ...testVisemes(envelope.length),
          source: 'test',
        }
        sendToPuppet('avatar://sentence', msg)
      }
    } catch (e) {
      onError(`Test failed: ${errText(e)}`)
    } finally {
      testing = false
    }
  }

  async function rename(c: Rig, input: HTMLInputElement) {
    if (input.value.trim() === c.name) return
    try {
      await api.avatarRename(c.id, input.value)
      await refresh()
    } catch (e) {
      input.value = c.name
      onError(`Rename failed: ${errText(e)}`)
    }
  }

  async function remove(c: Rig) {
    if (!(await ask(`Delete the character "${c.name}" and its copied image? This cannot be undone.`, { title: 'Delete character', kind: 'warning' })))
      return
    try {
      await api.avatarDelete(c.id)
      if (settings.avatarActive === c.id) settings.avatarActive = null
      await refresh()
    } catch (e) {
      onError(`Delete failed: ${errText(e)}`)
    }
  }
</script>

<div class="card">
  <div class="card-h"><h2>Avatar</h2></div>
  <div class="top">
    <button
      type="button"
      class="switch"
      role="switch"
      aria-checked={avatar.open}
      aria-label="Avatar window"
      title={avatar.open ? 'Close the avatar window' : 'Open a window with a figure that moves its mouth while replies are spoken'}
      onclick={() => toggleAvatar(settings.avatarBg).catch((e) => onError(errText(e)))}
      ><span class="track"></span><span class="swl">Avatar window</span></button
    >
    <button
      type="button"
      class="sm"
      disabled={testing}
      title="Speak a short sample sentence with the selected voice so you can watch the avatar without chatting (opens the avatar window; without speech running it plays a silent mouth test)"
      onclick={testSpeech}><Icon name="play" />Test speech</button
    >
  </div>
  <div class="row">
    <label class="field">
      <span class="label">Background</span>
      <span class="select-wrap">
        <select bind:value={settings.avatarBg} title="Window background; switching to or from Transparent reopens the avatar window">
          <option value="normal">Normal (theme)</option>
          <option value="green">Green screen (#00ff00)</option>
          <option value="transparent">Transparent</option>
        </select><Icon name="chev-down" />
      </span>
    </label>
    <label
      class="field"
      title={settings.avatarBg === 'transparent' ? 'How opaque the window background is; the figure stays solid' : 'How opaque the figure is'}
    >
      <span class="label">{settings.avatarBg === 'transparent' ? 'Background opacity' : 'Figure opacity'}</span>
      <span class="range">
        <input type="range" min="0" max="100" step="1" bind:value={settings.avatarOpacity} />
        <output>{settings.avatarOpacity}%</output>
      </span>
    </label>
  </div>
  <p class="help">Transparency can only be set when the window is created, so switching to or from Transparent reopens it.</p>
</div>

<div class="card">
  <div class="card-h">
    <h2 id="chars-h">Characters</h2>
    <div class="fit" use:fit>
      <Btn
        icon="plus"
        label={importing ? 'Importing…' : 'Import image…'}
        short="Import…"
        title="Add a character from a PNG, JPEG or WebP image (max 20 MB, 8192 px per side); the image is copied into the app data folder"
        disabled={importing}
        onclick={importImage}
      />
    </div>
  </div>
  <div class="list" role="radiogroup" aria-labelledby="chars-h">
    <label class="item" title="Show the built-in demo figure in the avatar window">
      <input type="radio" name="avatar-character" value={null} bind:group={settings.avatarActive} />
      <span class="ic"><Icon name="user" /></span>
      <span class="txt"><span class="n">Demo figure</span><span class="s">Built in</span></span>
    </label>
    {#each characters as c (c.id)}
      <div class="item">
        <input
          type="radio"
          name="avatar-character"
          value={c.id}
          bind:group={settings.avatarActive}
          aria-label={`Show ${c.name} in the avatar window`}
          title={`Show ${c.name} in the avatar window`}
        />
        {#if thumbs[c.id]}<span class="thumb"><img src={thumbs[c.id]} alt="" style:clip-path={clip(c)} /></span>{:else}<span class="ic"><Icon name="user" /></span>{/if}
        <span class="txt">
          <input
            class="cname"
            value={c.name}
            maxlength="80"
            aria-label={`Name of ${c.name}`}
            title="Rename: type a new name, then press Enter or leave the field"
            onchange={(e) => rename(c, e.currentTarget)}
            onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <span class="s"
            ><span
              class="badge"
              title={c.kind === 'fullbody'
                ? 'Full body: has arm or leg parts, which gesture while it speaks'
                : 'Portrait: no arm or leg parts (add some with Edit parts for a full-body figure)'}>{c.kind === 'fullbody' ? 'Full body' : 'Portrait'}</span
            >
            <span title={facts(c)}>{facts(c)}</span></span
          >
        </span>
        <div class="fit" use:fit>
          <Btn
            icon="scissors"
            label="Edit mask"
            short="Mask"
            class="sm"
            title={`Outline ${c.name} so the avatar window shows only the figure, without the background`}
            onclick={() => (editing = c)}
          />
          <Btn
            icon="figure"
            label="Edit parts"
            short="Parts"
            class="sm"
            title={maskOutline(c)
              ? `Mark eyes, mouth, arms, hands and legs of ${c.name} so they can move`
              : `Mark eyes, mouth, arms, hands and legs of ${c.name} so they can move (edit the mask first for a clean cut-out)`}
            onclick={() => (editingParts = c)}
          />
        </div>
        <button
          type="button"
          class="icon-only ghost danger"
          title={`Delete ${c.name} and its copied image (asks for confirmation)`}
          aria-label={`Delete ${c.name}`}
          onclick={() => remove(c)}><Icon name="trash" /></button
        >
      </div>
    {/each}
  </div>
  <p class="help">
    Edit mask cuts the figure out of its background; without a mask the avatar window shows the whole image. Edit
    parts marks eyes, mouth and limbs: the mouth opens with the loudness of the speech, the eyes blink, and arms and
    legs gesture while it speaks. Use Test speech above to watch it.
  </p>
</div>

<div class="card">
  <div class="card-h">
    <h2>Smart select model</h2>
    <div class="fit" use:fit>
      <Btn
      icon="trash"
      label={samBusy ? 'Removing…' : 'Remove model…'}
      short="Remove…"
      title="Delete the smart select model and runtime from this computer (asks first; using it again needs a new download)"
      disabled={!sam?.bytes || samBusy}
        onclick={samRemove}
      />
    </div>
  </div>
  <p class="help">
    {#if !sam}Checking…
    {:else if sam.installed}Installed: MobileSAM and ONNX Runtime, {formatBytes(sam.bytes)} on disk. Used by Smart select in the mask editor; it runs offline.
    {:else if sam.bytes}Not installed; {formatBytes(sam.bytes)} of an unfinished download are on disk.
    {:else}Not installed. Smart select in the mask editor offers the download (about 60 MB).{/if}
  </p>
</div>

{#if editing}
  <MaskEditor
    rig={editing}
    onClose={() => {
      editing = null
      void samRefresh()
    }}
    onSaved={maskSaved}
  />
{/if}
{#if editingParts}
  <PartEditor rig={editingParts} onClose={() => (editingParts = null)} onSaved={maskSaved} />
{/if}

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }
  .row > .field {
    flex: 1 1 200px;
  }
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
  }
  .card-h > .fit,
  .item > .fit {
    flex: 0 1 auto;
  }
  label.item {
    cursor: pointer;
  }
  .item > input[type='radio'] {
    flex: none;
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--acc);
  }
  .thumb {
    width: 32px;
    height: 32px;
    border-radius: var(--r);
    background: var(--surface-2);
    flex: none;
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    display: block;
  }
  .cname {
    font-weight: 600;
    min-width: 0;
    padding: 2px 6px;
    margin-left: -6px;
    border-color: transparent;
    background: transparent;
  }
  .cname:hover,
  .cname:focus {
    border-color: var(--border-strong);
    background: var(--surface);
  }
</style>

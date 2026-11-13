<script lang="ts">
  import { onMount } from 'svelte'
  import { getVersion } from '@tauri-apps/api/app'
  import { api, errText } from './api'
  import Btn from './Btn.svelte'
  import Icon from './Icon.svelte'
  import { COMPONENTS, LICENSE_URL, NOTICES_URL, REPO_URL } from './licences'

  let { onError }: { onError: (msg: string) => void } = $props()

  let version = $state('')
  onMount(() => {
    getVersion().then((v) => (version = v), () => {})
  })

  const open = (url: string) => api.openLink(url).catch((e) => onError(errText(e)))

  // Links open in the system browser, never inside the app window (also for Ctrl+click and middle click).
  function onLinkClick(e: MouseEvent) {
    const a = (e.target as Element).closest<HTMLAnchorElement>('a[href]')
    if (!a) return
    e.preventDefault()
    if (e.type === 'click' || e.button === 1) open(a.href)
  }

  async function openNotices() {
    try {
      if (!(await api.openNotices())) await open(NOTICES_URL)
    } catch (e) {
      onError(errText(e))
    }
  }

  const groups = [
    { title: 'Shipped with the installer', items: COMPONENTS.filter((c) => c.source === 'shipped') },
    { title: 'Downloaded on request', items: COMPONENTS.filter((c) => c.source === 'download') },
  ]
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (delegated link clicks; links handle Enter themselves) -->
<div class="page-in about" onclick={onLinkClick} onauxclick={onLinkClick}>
  <header class="ph">
    <h1>About &amp; licences</h1>
    <p>Talkerbox is free software under the MIT License. It ships and downloads third-party components under their own licences.</p>
  </header>
  <div class="card">
    <div class="card-h">
      <span class="logo-tile"><Icon name="logo" /></span>
      <h2>Talkerbox {#if version}<span class="ver">v{version}</span>{/if}</h2>
    </div>
    <ul class="about-links">
      <li><Icon name="link" /><a href={REPO_URL} title="Open the project on GitHub in your browser">Project on GitHub</a></li>
      <li><Icon name="file" /><a href={LICENSE_URL} title="Open the MIT License text on GitHub in your browser">MIT License</a></li>
    </ul>
  </div>
  <div class="card">
    <div class="card-h">
      <h2>Third-party components</h2>
      <Btn
        icon="file"
        label="Full notices"
        class="ghost sm"
        title="Open THIRD_PARTY_NOTICES.md (all components and licence texts) from the install folder; opens it on GitHub when it is not there"
        onclick={openNotices}
      />
    </div>
    {#each groups as g (g.title)}
      <h3 class="lic-h">{g.title}</h3>
      <ul class="list">
        {#each g.items as c (c.name)}
          <li class="item">
            <span class="txt">
              <a class="n" href={c.url} title={`Open ${c.url} in your browser`}>{c.name}</a>
              <span class="s">{c.licence}</span>
            </span>
          </li>
        {/each}
      </ul>
    {/each}
  </div>
</div>

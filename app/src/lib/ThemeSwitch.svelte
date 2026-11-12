<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from './Icon.svelte'
  import { darkQuery, loadTheme, resolveTheme, saveTheme } from './theme'

  let stored = $state(loadTheme())
  let systemDark = $state(darkQuery().matches)
  const theme = $derived(resolveTheme(stored, systemDark))
  const dark = $derived(theme === 'dark')

  $effect(() => {
    document.documentElement.dataset.theme = theme
  })

  onMount(() => {
    const mq = darkQuery()
    const onChange = () => (systemDark = mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  })

  function toggle() {
    const next = dark ? 'light' : 'dark'
    stored = next
    saveTheme(next)
  }
</script>

<!-- A native button already toggles on Space and Enter. -->
<button
  type="button"
  class="theme-switch"
  role="switch"
  aria-checked={dark}
  aria-label="Dark mode"
  title={dark ? 'Dark mode is on: switch to light mode' : 'Dark mode is off: switch to dark mode'}
  onclick={toggle}
>
  <span class="ts-track" aria-hidden="true">
    <Icon name="sun" class="ts-sun" /><Icon name="moon" class="ts-moon" />
    <span class="ts-knob"><Icon name={dark ? 'moon' : 'sun'} /></span>
  </span>
  <span class="ts-l">Dark mode</span>
</button>

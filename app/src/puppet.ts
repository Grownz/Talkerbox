// Entry of the avatar (puppet) window, a second page of the same Vite app (puppet.html).
import { mount } from 'svelte'
import './app.css'
import PuppetView from './lib/PuppetView.svelte'
import { darkQuery, loadTheme, resolveTheme } from './lib/theme'

// Follow the main window's theme switch (same origin, so its localStorage write fires `storage` here).
const applyTheme = () => (document.documentElement.dataset.theme = resolveTheme(loadTheme(), darkQuery().matches))
applyTheme()
addEventListener('storage', applyTheme)
darkQuery().addEventListener('change', applyTheme)

export default mount(PuppetView, { target: document.getElementById('app')! })

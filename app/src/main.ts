import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { darkQuery, loadTheme, resolveTheme } from './lib/theme'

// Set the theme before the first render (the CSP forbids an inline script in index.html).
document.documentElement.dataset.theme = resolveTheme(loadTheme(), darkQuery().matches)

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app

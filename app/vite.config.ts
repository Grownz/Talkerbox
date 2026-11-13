import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// Tauri expects a fixed dev port and must not watch the Rust sources.
// puppet.html is the avatar window, a second page of the same app.
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { rollupOptions: { input: { main: 'index.html', puppet: 'puppet.html' } } },
})

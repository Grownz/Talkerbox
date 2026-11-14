// Test-only module hooks (not a test file itself): stub Tauri-backed imports by specifier, resolve the app's
// extensionless relative imports to `.ts`, and compile `.svelte.ts` runes modules in server mode ($state becomes a
// plain field, so the logic runs without the browser runtime).
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { compileModule } from 'svelte/compiler'

/** `stubs` maps an import specifier to the JS source of the module that replaces it. Call before importing. */
export function stubModules(stubs: Record<string, string>) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier in stubs) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true }
      if (specifier.startsWith('.') && !/\.(ts|js)$/.test(specifier)) return nextResolve(specifier + '.ts', context)
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (!url.endsWith('.svelte.ts')) return nextLoad(url, context)
      const js = compileModule(stripTypeScriptTypes(readFileSync(new URL(url), 'utf8')), { generate: 'server', filename: url }).js.code
      return { format: 'module', source: js, shortCircuit: true }
    },
  })
}

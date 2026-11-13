// Run with `npm test` (Node's built-in test runner with TypeScript type stripping).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COMPONENTS, LICENSE_URL, NOTICES_URL, REPO_URL } from '../src/lib/licences.ts'

const isHttps = (u: string) => URL.canParse(u) && new URL(u).protocol === 'https:'

test('every component has a name, a licence and an https link', () => {
  assert.ok(COMPONENTS.length > 0)
  for (const c of COMPONENTS) {
    assert.ok(c.name.trim(), 'empty name')
    assert.ok(c.licence.trim(), `no licence for ${c.name}`)
    assert.ok(isHttps(c.url), `${c.name}: ${c.url} is not an https URL`)
  }
  assert.equal(new Set(COMPONENTS.map((c) => c.name)).size, COMPONENTS.length, 'duplicate names')
})

test('project links are https', () => {
  for (const u of [REPO_URL, LICENSE_URL, NOTICES_URL]) assert.ok(isHttps(u), u)
})

test('every bundled frontend dependency is listed', () => {
  for (const name of ['Svelte', 'flag-icons', 'markdown-it']) assert.ok(COMPONENTS.some((c) => c.name === name && c.source === 'shipped'), name)
})

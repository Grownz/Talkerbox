// Run with `npm test`. ModelStatus with fake backend commands and dialog.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stubModules } from './hooks.ts'

const g = globalThis as any
g.__model = { answer: true, cancelled: [] as string[] }
stubModules({
  '@tauri-apps/plugin-dialog': 'export const ask = async () => globalThis.__model.answer',
  './api': `let n = 0
export const errText = (e) => String(e?.message ?? e)
export const newOpId = () => 'op' + ++n
export const api = { cancel: async (id) => void globalThis.__model.cancelled.push(id) }`,
})
const { ModelStatus } = await import('../src/lib/modelStatus.svelte.ts')

const fail = (msg: string) => () => Promise.reject(new Error(msg))
function model(over: Record<string, unknown> = {}) {
  const disk = { installed: false, bytes: 0, runtime: true }
  const cmd = {
    status: async () => ({ ...disk }),
    download: async () => void Object.assign(disk, { installed: true, bytes: 93 }),
    remove: async () => void Object.assign(disk, { installed: false, bytes: 0 }),
    ...over,
  }
  return new ModelStatus(cmd as any)
}

test('refresh, download and remove move between missing and ready', async () => {
  const m = model()
  await m.refresh()
  assert.equal(m.status, 'missing')
  await m.download()
  assert.deepEqual([m.status, m.bytes, m.err], ['ready', 93, ''])
  g.__model.answer = false
  assert.equal(await m.remove('Delete?', 'Remove'), false)
  assert.equal(m.status, 'ready')
  g.__model.answer = true
  assert.equal(await m.remove('Delete?', 'Remove'), true)
  assert.equal(m.status, 'missing')
})

test('a failed download ends in error with its message; a failed remove keeps the error text', async () => {
  const m = model({ download: fail('offline') })
  await m.download()
  assert.deepEqual([m.status, m.err], ['error', 'Download failed: offline'])
  const r = model({ remove: fail('locked') })
  await r.remove('Delete?', 'Remove')
  assert.equal(r.err, 'Removing failed: locked')
})

test('cancel stops the running download only', async () => {
  let release = () => {}
  const m = model({ download: () => new Promise<void>((r) => (release = r)) })
  m.cancel()
  assert.equal(g.__model.cancelled.length, 0)
  const done = m.download()
  assert.equal(m.status, 'downloading')
  m.cancel()
  assert.equal(g.__model.cancelled.length, 1)
  release()
  await done
})

test('run is busy while the job runs, then ready or error', async () => {
  const m = model()
  let during = ''
  await m.run(async () => void (during = m.status))
  assert.deepEqual([during, m.status], ['busy', 'ready'])
  await m.run(fail('no face'))
  assert.deepEqual([m.status, m.err], ['error', 'no face'])
})

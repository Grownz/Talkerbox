// Run with `npm test`. Speaker queue and stop behaviour with fake synthesis, audio and avatar.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stubModules } from './hooks.ts'

interface Pending {
  text: string
  resolve: () => void
  reject: (e: Error) => void
}
interface FakeSource {
  stopped: boolean
  onended: (() => void) | null
  connect(): void
  start(): void
  stop(): void
}
const fake = {
  synth: [] as Pending[],
  sources: [] as FakeSource[],
  puppet: [] as string[],
}
;(globalThis as any).__speakerFake = fake

// speaker.ts imports Tauri-backed modules: fakes record what it sends and let each test settle synthesis calls.
stubModules({
  './api': `const f = globalThis.__speakerFake
export const errText = (e) => String(e?.message ?? e)
export const api = { ttsSynthesize: (text) => new Promise((resolve, reject) =>
  f.synth.push({ text, reject, resolve: () => resolve({ wav: new ArrayBuffer(8), fallback: false }) })) }`,
  './avatar.svelte': `export const avatarShown = () => false
export const sendToPuppet = (ev) => globalThis.__speakerFake.puppet.push(ev)`,
})

;(globalThis as any).AudioContext = class {
  currentTime = 0
  destination = {}
  resume() {
    return Promise.resolve()
  }
  async decodeAudioData() {
    return { duration: 1, sampleRate: 16000, getChannelData: () => new Float32Array(16) }
  }
  createBufferSource() {
    const s: FakeSource = {
      stopped: false,
      onended: null,
      connect() {},
      start() {},
      stop() {
        s.stopped = true
      },
    }
    fake.sources.push(s)
    return s
  }
}

const { Speaker } = await import('../src/lib/speaker.ts')
const tick = () => new Promise((r) => setImmediate(r))

function setup() {
  fake.synth.length = 0
  fake.sources.length = 0
  fake.puppet.length = 0
  const sp = new Speaker('test')
  const log = { errors: [] as string[], speaking: [] as boolean[] }
  sp.onError = (m) => log.errors.push(m)
  sp.onSpeaking = (on) => log.speaking.push(on)
  return { sp, log }
}

test('sentences are synthesised one at a time, in order, and played back to back', async () => {
  const { sp, log } = setup()
  sp.feed('One. Two. Thr')
  sp.flush()
  assert.deepEqual(log.speaking, [true])
  assert.deepEqual(fake.synth.map((p) => p.text.trim()), ['One.']) // the next waits for this one
  fake.synth[0].resolve()
  await tick()
  assert.equal(fake.sources.length, 1)
  assert.deepEqual(fake.synth.map((p) => p.text.trim()), ['One.', 'Two.'])
  fake.synth[1].resolve()
  await tick()
  fake.synth[2].resolve()
  await tick()
  assert.equal(fake.synth[2].text.trim(), 'Thr')
  assert.equal(fake.sources.length, 3)
  assert.equal(sp.speaking, true) // still playing
  for (const s of fake.sources) s.onended!()
  assert.deepEqual(log.speaking, [true, false])
  assert.equal(log.errors.length, 0)
})

test('stop drops the queue, stops playback, and a late synthesis result is never played', async () => {
  const { sp, log } = setup()
  sp.feed('One. Two. Three. ')
  fake.synth[0].resolve()
  await tick()
  assert.equal(fake.sources.length, 1)
  sp.stop()
  assert.ok(fake.sources[0].stopped)
  assert.ok(fake.puppet.includes('avatar://stop'))
  assert.equal(sp.speaking, true) // the synthesis of "Two." is still in flight
  fake.synth[1].resolve()
  await tick()
  assert.equal(fake.sources.length, 1) // not played
  assert.equal(fake.synth.length, 2) // "Three." was dropped
  assert.deepEqual(log.speaking, [true, false])
})

test('a failure of a cancelled sentence is not reported; a current one is, and speech goes on', async () => {
  const { sp, log } = setup()
  sp.feed('One. Two. ')
  sp.stop()
  fake.synth[0].reject(new Error('sidecar stopped'))
  await tick()
  assert.deepEqual(log.errors, [])

  sp.feed('Three. Four. ')
  fake.synth[1].reject(new Error('boom'))
  await tick()
  assert.deepEqual(log.errors, ['Speech failed: boom'])
  assert.equal(fake.synth[2].text.trim(), 'Four.')
  fake.synth[2].resolve()
  await tick()
  assert.equal(fake.sources.length, 1)
})

test('new text right after stop is spoken once the cancelled synthesis returns', async () => {
  const { sp } = setup()
  sp.feed('Old. ')
  sp.stop()
  sp.feed('New. ')
  assert.equal(fake.synth.length, 1) // one synthesis at a time
  fake.synth[0].resolve()
  await tick()
  assert.equal(fake.sources.length, 0) // the old sentence is discarded
  assert.equal(fake.synth[1].text.trim(), 'New.')
  fake.synth[1].resolve()
  await tick()
  assert.equal(fake.sources.length, 1)
})

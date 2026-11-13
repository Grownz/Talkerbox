import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalBus } from '../src/lib/localBus.ts'

const flush = () => new Promise<void>((r) => queueMicrotask(r))

test('events reach the listeners of that name only, until they unlisten', async () => {
  const bus = new LocalBus()
  const got: unknown[] = []
  const off = await bus.listen<{ n: number }>('avatar://sentence', (e) => got.push(e.payload.n))
  await bus.listen('avatar://stop', () => got.push('stop'))
  bus.emit('avatar://sentence', { n: 1 })
  bus.emit('avatar://other', { n: 2 })
  bus.emit('avatar://stop')
  await flush()
  off()
  bus.emit('avatar://sentence', { n: 3 })
  await flush()
  assert.deepEqual(got, [1, 'stop'])
})

test('a listener that unlistens while handling an event does not break delivery to the others', async () => {
  const bus = new LocalBus()
  const got: string[] = []
  const off = await bus.listen('e', () => {
    got.push('a')
    off()
  })
  await bus.listen('e', () => got.push('b'))
  bus.emit('e')
  await flush()
  bus.emit('e')
  await flush()
  assert.deepEqual(got, ['a', 'b', 'b'])
})

test('delivery is asynchronous: a listener never runs inside the emit call', async () => {
  const bus = new LocalBus()
  let ran = false
  await bus.listen('e', () => (ran = true))
  bus.emit('e')
  assert.equal(ran, false)
  await flush()
  assert.equal(ran, true)
})

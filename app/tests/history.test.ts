// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stubModules } from './hooks.ts'

stubModules({})
const { History } = await import('../src/lib/history.svelte.ts')

function doc() {
  const d = { v: 0, history: null as unknown as InstanceType<typeof History<number>> }
  d.history = new History<number>(() => d.v, (s) => (d.v = s))
  return d
}

test('undo and redo walk the snapshots; a new step clears redo', () => {
  const d = doc()
  for (const v of [1, 2, 3]) {
    d.history.commit()
    d.v = v
  }
  d.history.undo()
  d.history.undo()
  assert.equal(d.v, 1)
  d.history.redo()
  assert.equal(d.v, 2)
  d.history.commit()
  d.v = 9
  assert.equal(d.history.redoStack.length, 0)
  d.history.undo()
  assert.equal(d.v, 2)
  d.history.undo()
  d.history.undo()
  d.history.undo() // nothing left: no change
  assert.equal(d.v, 0)
})

test('a drag (begin on every input, end once) is one step back to the state before it', () => {
  const d = doc()
  for (const v of [5, 6, 7]) {
    d.history.begin()
    d.v = v
  }
  d.history.end()
  d.history.end() // a second end adds nothing
  assert.equal(d.history.undoStack.length, 1)
  d.history.undo()
  assert.equal(d.v, 0)
})

test('keeps the last 200 steps; clear forgets them', () => {
  const d = doc()
  for (let i = 1; i <= 250; i++) {
    d.history.commit()
    d.v = i
  }
  assert.equal(d.history.undoStack.length, 200)
  assert.equal(d.history.undoStack[0], 50)
  d.history.undo()
  d.history.clear()
  assert.deepEqual([d.history.undoStack.length, d.history.redoStack.length], [0, 0])
})

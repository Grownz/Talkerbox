import assert from 'node:assert/strict'
import { test } from 'node:test'
import { joinDraft, sttLanguageName } from '../src/lib/stt.ts'

test('dictated text is appended to what was typed before', () => {
  assert.equal(joinDraft('Hello', 'how are you'), 'Hello how are you')
  assert.equal(joinDraft('Hello  \n', ' world '), 'Hello world')
  assert.equal(joinDraft('', 'only speech'), 'only speech')
  assert.equal(joinDraft('typed only', ''), 'typed only')
  assert.equal(joinDraft('', ''), '')
})

test('language names fall back to the code', () => {
  assert.equal(sttLanguageName('de'), 'German')
  assert.equal(sttLanguageName('xx'), 'xx')
})

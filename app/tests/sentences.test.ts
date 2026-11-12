import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkLong, MAX_CHUNK, splitSentences } from '../src/lib/sentences.ts'

test('English sentences split after terminators and keep the unfinished tail', () => {
  assert.deepEqual(splitSentences('Hello there. How are you? I am "fine." And'), {
    sentences: ['Hello there. ', 'How are you? ', 'I am "fine." '],
    rest: 'And',
  })
  // No whitespace yet after the dot: the sentence may continue (e.g. "3.5"), so it stays pending.
  assert.deepEqual(splitSentences('Pi is 3.14'), { sentences: [], rest: 'Pi is 3.14' })
  assert.deepEqual(splitSentences('Line one\nLine two'), { sentences: ['Line one\n'], rest: 'Line two' })
})

test('CJK terminators split without a following space', () => {
  assert.deepEqual(splitSentences('你好。今天天气很好！你呢？还有'), {
    sentences: ['你好。', '今天天气很好！', '你呢？'],
    rest: '还有',
  })
  assert.deepEqual(splitSentences('こんにちは。元気'), { sentences: ['こんにちは。'], rest: '元気' })
})

test('long text is cut at the last space or comma before the limit', () => {
  const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ') // ~4,700 chars
  const chunks = chunkLong(words)
  assert.ok(chunks.length >= 3)
  for (const c of chunks) assert.ok(c.length <= MAX_CHUNK && c.length > 0, `chunk length ${c.length}`)
  assert.equal(chunks.join(' '), words) // nothing lost, no word broken
  assert.deepEqual(chunkLong('a,b,c', 3), ['a,', 'b,c'])
})

test('text without break points is hard-cut; short text is untouched', () => {
  assert.deepEqual(chunkLong('x'.repeat(3500)).map((c) => c.length), [1500, 1500, 500])
  assert.deepEqual(chunkLong('Short.'), ['Short.'])
  assert.deepEqual(chunkLong('   '), [])
})

import { SpeechText } from '../src/lib/sentences.ts'

/** Feeds chunks into a fresh SpeechText and returns everything it would speak. */
function speak(...chunks: string[]): string[] {
  const s = new SpeechText()
  return [...chunks.flatMap((c) => s.feed(c)), ...s.flush()].map((x) => x.trim())
}

const reply = 'Here is code:\n```python\nprint("hi")\nx = 1\n```\nThat prints hi. Done'

test('fenced code in one chunk is skipped', () => {
  assert.deepEqual(speak(reply), ['Here is code:', 'That prints hi.', 'Done'])
})

test('fence markers split across stream chunks are still detected', () => {
  // Every possible single split point, plus character-by-character streaming.
  for (let i = 0; i <= reply.length; i++) {
    assert.deepEqual(speak(reply.slice(0, i), reply.slice(i)), ['Here is code:', 'That prints hi.', 'Done'], `split at ${i}`)
  }
  assert.deepEqual(speak(...reply), ['Here is code:', 'That prints hi.', 'Done'])
})

test('an unclosed fence at the end stays silent, and the next reply starts fresh', () => {
  const s = new SpeechText()
  const first = [...s.feed('Look:\n```js\nconst a = 1\n'), ...s.flush()].map((x) => x.trim())
  assert.deepEqual(first, ['Look:'])
  assert.deepEqual([...s.feed('Next reply. '), ...s.flush()].map((x) => x.trim()), ['Next reply.'])
})

test('inline code and backticks inside a line are kept for the markdown cleanup', () => {
  assert.deepEqual(speak('Use `npm test` to run it. '), ['Use `npm test` to run it.'])
  assert.deepEqual(speak('`x` is a variable. '), ['`x` is a variable.'])
  assert.deepEqual(speak('Indented:\n  ```\n  code\n  ```\nEnd.'), ['Indented:', 'End.'])
})

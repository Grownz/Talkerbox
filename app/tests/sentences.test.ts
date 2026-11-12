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

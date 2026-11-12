// Sentence splitting for streamed speech. Pure module, tested with `node --test`.

// End of a sentence: . ! ? or an ellipsis followed by whitespace (optionally after a closing quote/bracket),
// CJK full-width terminators (no space follows them), or a newline.
const SENTENCE_END = /[.!?…]+["')\]]*\s+|[。！？]+|\n+/

/** The sidecar rejects texts over 2000 characters; stay well below. */
export const MAX_CHUNK = 1500

/** Splits off every complete sentence; `rest` is the unfinished tail to keep for the next chunk. */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  let rest = text
  let m: RegExpExecArray | null
  while ((m = SENTENCE_END.exec(rest))) {
    const end = m.index + m[0].length
    sentences.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  return { sentences, rest }
}

/**
 * Streaming text -> speakable sentences, skipping fenced code blocks (lines starting with ```), even when a
 * fence marker arrives split across chunks. Inline `code` is left to the caller's markdown cleanup.
 */
export class SpeechText {
  private inFence = false
  /** Start of the current line while it may still turn out to be a fence marker. */
  private head = ''
  private mode: 'undecided' | 'prose' | 'skip' = 'undecided'
  private prose = ''

  /** Feeds a chunk; returns the sentences completed by it. */
  feed(text: string): string[] {
    for (const ch of text) {
      if (this.mode !== 'undecided') {
        if (this.mode === 'prose') this.prose += ch
        if (ch === '\n') this.mode = 'undecided'
        continue
      }
      this.head += ch
      if (ch === '\n') {
        this.endLine()
        continue
      }
      const t = this.head.trimStart()
      if ('```'.startsWith(t)) continue // '', '`', '``' or '```': could still be a fence marker
      if (t.startsWith('```')) {
        this.inFence = !this.inFence // marker line; the rest (e.g. a language tag) is skipped
        this.mode = 'skip'
      } else {
        this.mode = this.inFence ? 'skip' : 'prose'
        if (this.mode === 'prose') this.prose += this.head
      }
      this.head = ''
    }
    return this.take()
  }

  /** End of the reply: returns everything left (an unclosed fence stays skipped) and resets the state. */
  flush(): string[] {
    if (this.mode === 'undecided' && this.head) this.endLine()
    const out = this.take()
    if (this.prose.trim()) out.push(this.prose)
    this.inFence = false
    this.head = this.prose = ''
    this.mode = 'undecided'
    return out
  }

  private endLine() {
    if (this.head.trim().startsWith('```')) this.inFence = !this.inFence
    else if (!this.inFence) this.prose += this.head
    this.head = ''
    this.mode = 'undecided'
  }

  private take(): string[] {
    const { sentences, rest } = splitSentences(this.prose)
    this.prose = rest
    return sentences
  }
}

/** Cuts text longer than `max` at the last space or comma before the limit (hard cut if there is none). */
export function chunkLong(text: string, max = MAX_CHUNK): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut = Math.max(window.lastIndexOf(' '), window.lastIndexOf(','), window.lastIndexOf('，'))
    const at = cut > 0 ? cut + 1 : max
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at)
  }
  if (rest.trim()) out.push(rest.trim())
  return out
}

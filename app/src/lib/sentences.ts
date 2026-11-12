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

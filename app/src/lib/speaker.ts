// Sentence-by-sentence speech: streamed text in, WebAudio playback out.
import { api, errText } from './api'

// A sentence ends at . ! ? or an ellipsis followed by whitespace (optionally after a closing quote/bracket), or at a newline.
const SENTENCE_END = /[.!?…]+["')\]]*\s+|\n+/

/** Removes markdown syntax that would otherwise be read aloud. */
export function speakable(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`~|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export class Speaker {
  voice = ''
  speed = 1
  onError: (msg: string) => void = () => {}

  private ctx: AudioContext | null = null
  private pending = ''
  private queue: string[] = []
  private gen = 0
  private working = false
  private sources = new Set<AudioBufferSourceNode>()
  private nextStart = 0

  /** Call from a user gesture so the browser allows audio playback. */
  unlock() {
    this.ctx ??= new AudioContext()
    void this.ctx.resume()
  }

  /** Feeds streamed text; every completed sentence is queued for synthesis. */
  feed(text: string) {
    this.pending += text
    let m: RegExpExecArray | null
    while ((m = SENTENCE_END.exec(this.pending))) {
      const end = m.index + m[0].length
      this.enqueue(this.pending.slice(0, end))
      this.pending = this.pending.slice(end)
    }
  }

  /** Queues whatever text is left (end of reply). */
  flush() {
    this.enqueue(this.pending)
    this.pending = ''
  }

  stop() {
    this.gen++
    this.queue = []
    this.pending = ''
    for (const s of this.sources) s.stop()
    this.sources.clear()
    this.nextStart = 0
  }

  private enqueue(raw: string) {
    const text = speakable(raw)
    if (!/[\p{L}\p{N}]/u.test(text)) return
    this.queue.push(text)
    void this.run()
  }

  // Synthesis of the next sentence overlaps with playback of the current one.
  private async run() {
    if (this.working) return
    this.working = true
    const gen = this.gen
    try {
      while (this.queue.length && gen === this.gen) {
        const text = this.queue.shift()!
        try {
          const wav = await api.ttsSynthesize(text, this.voice, this.speed)
          if (gen !== this.gen) break
          this.unlock()
          const buf = await this.ctx!.decodeAudioData(wav)
          if (gen !== this.gen) break
          this.play(buf)
        } catch (e) {
          this.onError(`Speech failed: ${errText(e)}`)
        }
      }
    } finally {
      this.working = false
      if (this.queue.length) void this.run()
    }
  }

  private play(buf: AudioBuffer) {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    const at = Math.max(ctx.currentTime, this.nextStart)
    src.start(at)
    this.nextStart = at + buf.duration
    this.sources.add(src)
    src.onended = () => this.sources.delete(src)
  }
}

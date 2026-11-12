// Sentence-by-sentence speech: streamed text in, WebAudio playback out.
import { api, errText } from './api'
import { chunkLong, SpeechText } from './sentences'

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
  /** The sidecar reported (X-TTS-Fallback) that it used the base model for this voice. */
  onFallback: (voice: string) => void = () => {}
  /** Called when speech starts (sentences queued, synthesising or playing) and when it is over. */
  onSpeaking: (on: boolean) => void = () => {}
  private speaking = false

  private ctx: AudioContext | null = null
  private text = new SpeechText()
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
    for (const s of this.text.feed(text)) this.enqueue(s)
  }

  /** Queues whatever text is left (end of reply). */
  flush() {
    for (const s of this.text.flush()) this.enqueue(s)
  }

  stop() {
    this.gen++
    this.queue = []
    this.text = new SpeechText()
    for (const s of this.sources) s.stop()
    this.sources.clear()
    this.nextStart = 0
    this.update()
  }

  private update() {
    const on = this.working || this.queue.length > 0 || this.sources.size > 0
    if (on !== this.speaking) this.onSpeaking((this.speaking = on))
  }

  private enqueue(raw: string) {
    const text = speakable(raw)
    if (!/[\p{L}\p{N}]/u.test(text)) return
    this.queue.push(...chunkLong(text))
    this.update()
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
          const { wav, fallback } = await api.ttsSynthesize(text, this.voice, this.speed)
          if (fallback) this.onFallback(this.voice)
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
      else this.update()
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
    src.onended = () => {
      this.sources.delete(src)
      this.update()
    }

  }
}

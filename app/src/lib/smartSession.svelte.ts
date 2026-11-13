// Smart select session shared by the mask editor and the part editor: model state (download, encode, ready, remove),
// prompts from clicks and box drags, the proposal from the decoder, and its overlay. Pure prompt maths lives in
// smartSelect.ts; the model runs in Rust (src-tauri/src/sam.rs).
import { ask } from '@tauri-apps/plugin-dialog'
import { api, errText, formatBytes, newOpId, type Progress } from './api'
import type { Point } from './rig'
import { encodeSize, samPrompt, type Prompt } from './smartSelect'

export type SamState = 'unknown' | 'missing' | 'downloading' | 'loading' | 'ready' | 'error'
const MAX_PROMPTS = 60

export class SmartSession {
  status = $state<SamState>('unknown')
  err = $state('')
  info = $state('')
  progress = $state<Progress | null>(null)
  prompts = $state.raw<Prompt[]>([])
  /** Proposed mask for the prompts: out-size bytes (see `setImage`), 1 = inside. */
  proposal = $state.raw<Uint8Array | null>(null)
  /** Press in progress: a click (no `b`) or a box drag. */
  pending: { a: Point; b: Point | null; sx: number; sy: number; neg: boolean } | null = null
  private img: { bitmap: ImageBitmap; key: string; w: number; h: number; ow: number; oh: number } | null = null
  private enc: [number, number] = [1, 1]
  private seq = 0
  private op: string | null = null
  private overlay = document.createElement('canvas')
  private painted: { m: Uint8Array | null; colour: string } = { m: null, colour: '' }

  /** The image to work on (`w`*`h`, cache `key`) and the size of the masks it returns (`ow`*`oh`). */
  setImage(bitmap: ImageBitmap, key: string, w: number, h: number, ow: number, oh: number) {
    this.img = { bitmap, key, w, h, ow, oh }
  }

  /** Checks the model and encodes the image once; call when the tool is picked (again after the image loaded). */
  async start() {
    if (this.status !== 'unknown' && this.status !== 'error') return
    try {
      if ((await api.samStatus()).installed) await this.encode()
      else this.status = 'missing'
    } catch (e) {
      this.status = 'error'
      this.err = errText(e)
    }
  }

  /** Encodes the image (the backend skips it when this key was encoded last); loads the model on first use. */
  private async encode() {
    const img = this.img
    if (!img) return void (this.status = 'unknown') // image still loading: `start` runs again once it is there
    this.status = 'loading'
    this.err = ''
    const [ew, eh] = (this.enc = encodeSize(img.w, img.h))
    const c = document.createElement('canvas')
    c.width = ew
    c.height = eh
    const cx = c.getContext('2d', { willReadFrequently: true })!
    cx.imageSmoothingQuality = 'high'
    cx.drawImage(img.bitmap, 0, 0, ew, eh)
    try {
      const ms = await api.samEncode(img.key, cx.getImageData(0, 0, ew, eh).data, ew, eh)
      this.info = ms ? `Image analysed in ${Math.round(ms)} ms.` : ''
      this.status = 'ready'
      void this.decode()
    } catch (e) {
      this.status = 'error'
      this.err = errText(e)
    }
  }

  async download() {
    const id = (this.op = newOpId())
    this.status = 'downloading'
    this.err = ''
    this.progress = null
    try {
      const cancelled = await api.samDownload(id, (p) => (this.progress = p))
      this.op = null
      if (cancelled) this.status = 'missing'
      else await this.encode()
    } catch (e) {
      this.op = null
      this.status = 'error'
      this.err = `Download failed: ${errText(e)}`
    }
  }

  cancel() {
    if (this.op) void api.cancel(this.op)
  }

  /** Retry after an error: a failed download downloads again, anything else checks and encodes again. */
  retry() {
    return this.err.startsWith('Download') ? this.download() : this.start()
  }

  /** Deletes the downloaded model after a confirmation (it is unloaded first). */
  async remove() {
    try {
      const { bytes } = await api.samStatus()
      const ok = await ask(`Delete the smart select model and runtime (${formatBytes(bytes)})? Using smart select again needs a new download of about 60 MB.`, {
        title: 'Remove smart select model',
        kind: 'warning',
        okLabel: 'Remove',
        cancelLabel: 'Keep',
      })
      if (!ok) return
      this.clear()
      await api.samRemove()
      this.status = 'missing'
      this.info = this.err = ''
    } catch (e) {
      this.status = 'error'
      this.err = `Removing failed: ${errText(e)}`
    }
  }

  private async decode() {
    const seq = ++this.seq
    const q = samPrompt(this.prompts, ...this.enc)
    if (!q || this.status !== 'ready' || !this.img) return void (this.proposal = null)
    try {
      const m = await api.samDecode(q.points, q.labels, this.img.ow, this.img.oh)
      if (seq === this.seq) this.proposal = m
    } catch (e) {
      if (seq !== this.seq) return
      // The model was freed meanwhile (an editor closing releases it): load and encode again, then retry.
      if (/not loaded|no image encoded/.test(errText(e))) {
        this.status = 'unknown'
        return void this.start()
      }
      this.err = errText(e)
    }
  }

  add(p: Prompt) {
    if (this.status !== 'ready' || this.prompts.length >= MAX_PROMPTS) return
    this.prompts = [...this.prompts, p]
    void this.decode()
  }
  undo() {
    this.prompts = this.prompts.slice(0, -1)
    void this.decode()
  }
  clear() {
    this.seq++
    this.prompts = []
    this.proposal = null
    this.pending = null
  }

  // Pointer input in normalised image coordinates `p` plus screen position (sx, sy): a click adds a point (right
  // button or Alt: background), a drag of more than 5 px draws a box; decided on release.
  down(p: Point, sx: number, sy: number, button: number, alt: boolean) {
    if (button === 2) this.add({ kind: 'point', p, positive: false })
    else if (button === 0) this.pending = { a: p, b: null, sx, sy, neg: alt }
  }
  /** True while a box is being dragged (the host redraws). */
  move(p: Point, sx: number, sy: number): boolean {
    const d = this.pending
    if (!d || (!d.b && Math.hypot(sx - d.sx, sy - d.sy) <= 5)) return false
    d.b = p
    return true
  }
  /** `commit` false (pointer cancelled) drops the press. */
  up(commit: boolean) {
    const d = this.pending
    this.pending = null
    if (!d || !commit) return
    if (!d.b) this.add({ kind: 'point', p: d.a, positive: !d.neg })
    else if (Math.abs(d.b[0] - d.a[0]) > 1e-3 && Math.abs(d.b[1] - d.a[1]) > 1e-3) this.add({ kind: 'box', a: d.a, b: d.b })
  }

  /** Draws the proposal (in `colour`, over the image drawn at ox, oy with size dw*dh), the prompts and a box drag. */
  draw(ctx: CanvasRenderingContext2D, toScreen: (p: Point) => Point, ox: number, oy: number, dw: number, dh: number, colour: [number, number, number]) {
    const m = this.proposal
    const key = colour.join()
    if (m && this.img && m.length === this.img.ow * this.img.oh && (m !== this.painted.m || key !== this.painted.colour)) {
      const { ow, oh } = this.img
      this.overlay.width = ow
      this.overlay.height = oh
      const g = this.overlay.getContext('2d')!
      const data = g.createImageData(ow, oh)
      const rgba = [...colour, 255]
      for (let i = 0; i < m.length; i++) if (m[i]) data.data.set(rgba, i * 4)
      g.putImageData(data, 0, 0)
      this.painted = { m, colour: key }
    }
    if (m) {
      ctx.globalAlpha = 0.45
      ctx.drawImage(this.overlay, ox, oy, dw, dh)
      ctx.globalAlpha = 1
    }
    const rect = (a: Point, b: Point) => {
      const [x0, y0] = toScreen(a)
      const [x1, y1] = toScreen(b)
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 3
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
      ctx.setLineDash([5, 4])
      ctx.strokeStyle = '#111'
      ctx.lineWidth = 1.5
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
      ctx.setLineDash([])
    }
    for (const p of this.prompts) {
      if (p.kind === 'box') rect(p.a, p.b)
      else {
        const [x, y] = toScreen(p.p)
        ctx.beginPath()
        ctx.arc(x, y, 5.5, 0, Math.PI * 2)
        ctx.fillStyle = p.positive ? '#22c55e' : '#ef4444'
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }
    if (this.pending?.b) rect(this.pending.a, this.pending.b)
  }

  /** Every way out of an editor: stops a download and frees the model (a no-op when it was never loaded). */
  release() {
    this.cancel()
    void api.samRelease()
  }
}

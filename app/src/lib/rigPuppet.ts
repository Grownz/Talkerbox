// Renderer for a saved character in the avatar window: the shared renderer (rigRender.ts) on a canvas that fits the
// window (contain, centred, crisp on HiDPI). Textures are cut once per load; each frame only transforms and blits.
// Without a mask the whole image is shown; without parts it only sways, and bobs with the speech when there is no mouth.
import type { Puppet } from './demoPuppet'
import type { Rig } from './rig'
import { drawRig, rigSprites, type Pose, type RigSprites } from './rigRender'

/** Long side of the cached textures: enough for a large HiDPI window, far below an 8192 px import. */
const MAX_SIDE = 2048

export class RigPuppet implements Puppet {
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private sprites: RigSprites
  private w: number
  private h: number
  private bob: boolean
  private ro: ResizeObserver

  /** `img` must already be decoded (see PuppetView), so a broken image never replaces the current figure. */
  constructor(
    private host: HTMLElement,
    private rig: Rig,
    private img: HTMLImageElement,
  ) {
    // Real decoded size, so the 0..1 coordinates match what the editors showed.
    const iw = img.naturalWidth || rig.image.width
    const ih = img.naturalHeight || rig.image.height
    const s = Math.min(1, MAX_SIDE / Math.max(iw, ih))
    this.w = Math.max(1, Math.round(iw * s))
    this.h = Math.max(1, Math.round(ih * s))
    this.sprites = rigSprites(rig, img, this.w, this.h)
    this.bob = !rig.parts.some((p) => p.role === 'mouth')
    this.ctx = this.canvas.getContext('2d')!
    this.canvas.setAttribute('role', 'img')
    this.canvas.setAttribute('aria-label', rig.name)
    this.canvas.style.cssText = 'width:100%;height:100%;display:block'
    host.replaceChildren(this.canvas)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
  }

  private resize() {
    const dpr = devicePixelRatio || 1
    this.canvas.width = Math.max(1, Math.round(this.host.clientWidth * dpr))
    this.canvas.height = Math.max(1, Math.round(this.host.clientHeight * dpr))
  }

  frame(pose: Pose) {
    // Moving the window to a screen with another scale changes devicePixelRatio without a resize.
    if (this.canvas.width !== Math.max(1, Math.round(this.host.clientWidth * (devicePixelRatio || 1)))) this.resize()
    const { canvas, ctx, w, h } = this
    // Contain, with a little room for the sway (about the bottom centre) and the bob.
    const z = Math.min(canvas.width / (w * 1.04), canvas.height / (h * 1.03))
    const bob = this.bob ? -pose.mouth * 0.015 * h : 0
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.setTransform(z, 0, 0, z, (canvas.width - w * z) / 2, (canvas.height - h * z) / 2 + bob * z)
    drawRig(ctx, this.rig, this.img, w, h, pose, this.sprites)
  }

  destroy() {
    this.ro.disconnect()
  }
}

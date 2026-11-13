// "Fill (AI)": runs LaMa (src-tauri/src/inpaint.rs) on a 512 px crop around the area moving parts uncover and returns
// the result as a PNG to store with the character, plus the image area it covers. Browser-only glue; the geometry
// (crop, mask) is in fillUnder.ts and tested there.
import { api } from './api'
import { dilate, fillCrop, rasterize } from './fillUnder'
import type { Point } from './rig'

const SIDE = 512

export interface AiFill {
  png: Blob
  /** Area of the image the PNG covers: [x0, y0, x1, y1], 0..1. */
  rect: [number, number, number, number]
  img: ImageBitmap
  /** Model time (load + inference) as seen from the editor. */
  ms: number
}

export async function generateAiFill(bitmap: ImageBitmap, W: number, H: number, polys: Point[][]): Promise<AiFill> {
  const crop = fillCrop(polys, W, H)
  if (!crop) throw new Error('No arm, hand or leg parts: there is nothing to fill')
  const [x0, y0, x1, y1] = crop
  const c = document.createElement('canvas')
  c.width = c.height = SIDE
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.imageSmoothingQuality = 'high'
  g.drawImage(bitmap, x0, y0, x1 - x0, y1 - y0, 0, 0, SIDE, SIDE)
  const rgba = g.getImageData(0, 0, SIDE, SIDE).data
  // The parts in crop coordinates, grown by 4 px: LaMa needs the whole old outline (with its anti-aliased edge) masked.
  const local = polys.map((p) => p.map(([x, y]): Point => [(x * W - x0) / (x1 - x0), (y * H - y0) / (y1 - y0)]))
  const mask = dilate(rasterize(local, SIDE, SIDE), SIDE, SIDE, 4)
  for (let i = 0; i < mask.length; i++) rgba[i * 4 + 3] = mask[i] ? 255 : 0
  const t = performance.now()
  const out = await api.inpaintRun(rgba)
  const ms = performance.now() - t
  g.putImageData(new ImageData(new Uint8ClampedArray(out), SIDE, SIDE), 0, 0)
  const png = await new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('Cannot encode the fill image'))), 'image/png'))
  return { png, rect: [x0 / W, y0 / H, x1 / W, y1 / H], img: await createImageBitmap(c), ms }
}

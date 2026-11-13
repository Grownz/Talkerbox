<script lang="ts">
  // Mask editor: outline the figure with a polygon, brush, magic wand or smart select (MobileSAM, src-tauri/src/sam.rs),
  // smooth the outline and snap it to the image edges (geometry in maskGeometry.ts). The image is decoded once; brush,
  // wand, smart select results and snap work on a 512 px copy.
  import { ask } from '@tauri-apps/plugin-dialog'
  import { onMount } from 'svelte'
  import { api, errText } from './api'
  import Btn from './Btn.svelte'
  import { checker, fitView as fitTo, fitZoom, hitEdge as edgeAt, hitPoint as pointAt, zoomView, type View } from './canvasView'
  import { fit } from './fit'
  import Icon, { type IconName } from './Icon.svelte'
  import {
    MAX_MASK_POINTS,
    floodSelect,
    polygonArea,
    simplifyTo,
    smoothPolygon,
    snapToGradient,
    traceLargest,
  } from './maskGeometry'
  import { validateRig, type Point, type Rig } from './rig'
  import { mergeMask } from './smartSelect'
  import SmartSelectBar from './SmartSelectBar.svelte'
  import { SmartSession } from './smartSession.svelte'

  let { rig, onClose, onSaved }: { rig: Rig; onClose: () => void; onSaved: (r: Rig) => void } = $props()

  type Tool = 'polygon' | 'brush' | 'wand' | 'smart'
  type Snapshot = { raw: Point[]; closed: boolean; smooth: number; snap: number }
  const WORK = 512 // long side of the working bitmap
  const SNAP_MAX = 16 // search radius in working pixels at Snap 100%
  const TOOLS: { id: Tool; icon: IconName; label: string; short?: string; title: string }[] = [
    { id: 'polygon', icon: 'polygon', label: 'Polygon', title: 'Polygon tool: click points around the figure' },
    { id: 'brush', icon: 'brush', label: 'Brush', title: 'Brush tool: paint the figure (Erase removes)' },
    { id: 'wand', icon: 'wand', label: 'Magic wand', short: 'Wand', title: 'Magic wand: click a region of similar colour to add it (Erase removes)' },
    { id: 'smart', icon: 'target', label: 'Smart select', short: 'Smart', title: 'Smart select: click the figure and an on-device model proposes its outline (Erase removes)' },
  ]
  // Start from the stored size; replaced by the decoded bitmap's real size on load (the stored one can differ, e.g.
  // for a rotated photo, and the avatar window shows the image at its real aspect ratio).
  // svelte-ignore state_referenced_locally
  let W = rig.image.width
  // svelte-ignore state_referenced_locally
  let H = rig.image.height
  let ws = Math.min(1, WORK / Math.max(W, H))
  let ww = Math.max(1, Math.round(W * ws))
  let wh = Math.max(1, Math.round(H * ws))
  function setImageSize(w: number, h: number) {
    W = w
    H = h
    ws = Math.min(1, WORK / Math.max(W, H))
    ww = Math.max(1, Math.round(W * ws))
    wh = Math.max(1, Math.round(H * ws))
    paintCv.width = ww
    paintCv.height = wh
    snapPx = Math.round(SNAP_MAX / ws)
  }
  let snapPx = $state(SNAP_MAX) // snap search radius at 100% in image pixels, for the tooltip
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

  // svelte-ignore state_referenced_locally
  let base = $state.raw(rig)
  let raw = $state.raw<Point[]>([])
  let closed = $state(false)
  let smooth = $state(0)
  let snap = $state(0)
  let tool = $state<Tool>('polygon')
  let erase = $state(false)
  let brush = $state(24)
  let tolerance = $state(12)
  let preview = $state<'off' | 'checker' | 'green' | 'dark'>('off')
  let selected = $state(-1)
  let undoStack = $state.raw<Snapshot[]>([])
  let redoStack = $state.raw<Snapshot[]>([])
  let clean = $state('')
  let status = $state('')
  let failed = $state(false)
  let saving = $state(false)
  let loaded = $state(false)
  let spaceDown = $state(false)
  let panning = $state(false)
  let gray = $state.raw<Float32Array | null>(null)
  let bitmap: ImageBitmap | null = null
  let rgba: Uint8ClampedArray | null = null
  // Smart select session (model state, prompts, proposal at the working size), shared code with the part editor.
  const smart = new SmartSession()

  let canvas: HTMLCanvasElement
  let wrap: HTMLDivElement
  let cw = 0
  let ch = 0
  let view: View = { z: 1, ox: 0, oy: 0 }
  let fitted = true

  // Shown and saved outline: drawn points, snapped to edges, then smoothed (all in working pixels).
  const result = $derived.by((): Point[] => {
    if (!closed || raw.length < 3) return raw
    let p = raw.map(([x, y]): Point => [x * ww, y * wh])
    if (snap && gray) {
      const g = gray
      p = snapToGradient(p, (x, y) => g[y * ww + x], ww, wh, (snap / 100) * SNAP_MAX)
    }
    // Snapped outlines are dense (a point every 2 px); a light pass keeps the count sensible even at Smooth 0.
    p = smoothPolygon(p, snap ? Math.max(smooth / 100, 0.05) : smooth / 100)
    return p.map(([x, y]): Point => [clamp01(x / ww), clamp01(y / wh)])
  })
  const masked = $derived(closed && result.length >= 3)
  const area = $derived(masked ? Math.abs(polygonArea(result)) : 0)
  const key = () => JSON.stringify([closed ? raw : [], smooth, snap])
  const dirty = $derived(loaded && key() !== clean)
  const warning = $derived(
    !raw.length
      ? 'No mask yet: the avatar window shows the whole image.'
      : !closed
        ? 'The outline is open: click the first point, double-click or press Enter to close it.'
        : !masked
          ? 'The outline is too small to use.'
          : area < 0.01
            ? 'The mask covers less than 1% of the image.'
            : '',
  )
  const hint = $derived(
    preview !== 'off'
      ? 'Preview of the cut-out: drag to pan; switch the preview off to edit.'
      : tool === 'polygon'
        ? 'Click to add points; click the first point, double-click or press Enter to close. Drag a point to move it, click an edge to insert one; right-click or Delete removes a point, Backspace the last one while drawing.'
        : tool === 'brush'
          ? 'Paint over the figure; turn on Erase to remove. [ and ] change the brush size. Only the largest painted area is kept.'
          : tool === 'smart'
            ? 'Click the figure to select it; right-click or Alt+click marks background, drag to draw a box around it. Enter or "Add" merges the proposal into the mask (with Erase on it removes it); Backspace or Ctrl+Z removes the last point, Esc clears them.'
            : 'Click a region to add similar colours to the mask; with Erase on, a click removes them. Only the largest area is kept.',
  )

  function load(r: Rig) {
    base = r
    raw = r.mask.points
    closed = raw.length >= 3
    smooth = Math.round((r.mask.smooth ?? 0) * 100)
    snap = Math.round((r.mask.snap ?? 0) * 100)
    undoStack = []
    redoStack = []
    selected = -1
    clean = key()
  }

  // ---------- history ----------
  const snapshot = (): Snapshot => ({ raw, closed, smooth, snap })
  function push(s: Snapshot) {
    undoStack = [...undoStack.slice(-199), s]
    redoStack = []
  }
  const commit = () => push(snapshot())
  function restore(s: Snapshot) {
    raw = s.raw
    closed = s.closed
    smooth = s.smooth
    snap = s.snap
    selected = -1
  }
  function undo() {
    const s = undoStack.at(-1)
    if (!s) return
    redoStack = [...redoStack, snapshot()]
    undoStack = undoStack.slice(0, -1)
    restore(s)
  }
  function redo() {
    const s = redoStack.at(-1)
    if (!s) return
    undoStack = [...undoStack, snapshot()]
    redoStack = redoStack.slice(0, -1)
    restore(s)
  }
  // A slider drag is one undo step: the state before the first input is pushed when the drag ends.
  let pending: Snapshot | null = null
  function slide(which: 'smooth' | 'snap', v: number) {
    pending ??= snapshot()
    if (which === 'smooth') smooth = v
    else snap = v
  }
  function slideDone() {
    if (pending) push(pending)
    pending = null
  }

  // ---------- edits ----------
  function closeOutline() {
    if (closed || raw.length < 3) return
    commit()
    closed = true
  }
  function removePoint(i: number) {
    if (i < 0 || i >= raw.length) return
    commit()
    raw = raw.filter((_, j) => j !== i)
    if (raw.length < 3) closed = false
    selected = -1
  }
  function clear() {
    commit()
    raw = []
    closed = false
    selected = -1
  }
  function bake() {
    if (!masked) return
    commit()
    raw = result
    smooth = snap = 0
    selected = -1
  }

  // Brush and wand edit a bitmap made from the drawn outline, then trace it back into an outline.
  const paintCv = document.createElement('canvas')
  paintCv.width = ww
  paintCv.height = wh
  const pctx = paintCv.getContext('2d', { willReadFrequently: true })!
  let stroke: Point | null = null // last brush position (working px) while painting

  function rasterRaw() {
    pctx.globalCompositeOperation = 'source-over'
    pctx.clearRect(0, 0, ww, wh)
    pctx.fillStyle = pctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--acc').trim() || '#2563c9'
    if (!closed || raw.length < 3) return
    pctx.beginPath()
    for (const [x, y] of raw) pctx.lineTo(x * ww, y * wh)
    pctx.closePath()
    pctx.fill()
  }
  function readMask(): Uint8Array {
    const d = pctx.getImageData(0, 0, ww, wh).data
    const m = new Uint8Array(ww * wh)
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] >= 128 ? 1 : 0
    return m
  }
  function applyMask(m: Uint8Array) {
    const t = traceLargest(m, ww, wh)
    const pts = t.length >= 3 ? simplifyTo(t, 0.7) : []
    commit()
    raw = pts.length >= 3 ? pts.map(([x, y]): Point => [x / ww, y / wh]) : []
    closed = raw.length >= 3
    selected = -1
  }
  function strokeStart([x, y]: Point) {
    rasterRaw()
    pctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
    pctx.lineWidth = brush
    pctx.lineCap = pctx.lineJoin = 'round'
    stroke = [x * ww, y * wh]
    pctx.beginPath()
    pctx.arc(stroke[0], stroke[1], brush / 2, 0, Math.PI * 2)
    pctx.fill()
    draw()
  }
  function strokeTo([x, y]: Point) {
    if (!stroke) return
    pctx.beginPath()
    pctx.moveTo(stroke[0], stroke[1])
    stroke = [x * ww, y * wh]
    pctx.lineTo(stroke[0], stroke[1])
    pctx.stroke()
    draw()
  }
  function strokeEnd() {
    if (!stroke) return
    stroke = null
    applyMask(readMask())
  }
  function wand([x, y]: Point) {
    if (!rgba) return
    const sel = floodSelect(rgba, ww, wh, Math.min(ww - 1, Math.floor(x * ww)), Math.min(wh - 1, Math.floor(y * wh)), tolerance / 100)
    rasterRaw()
    const m = readMask()
    for (let i = 0; i < m.length; i++) m[i] = erase ? m[i] & (sel[i] ^ 1) : m[i] | sel[i]
    applyMask(m)
  }

  // ---------- smart select ----------
  function selectTool(t: Tool) {
    tool = t
    if (t !== 'smart') smart.clear()
    else void smart.start()
  }
  function acceptProposal() {
    if (!smart.proposal) return
    rasterRaw()
    applyMask(mergeMask(readMask(), smart.proposal, erase))
    smart.clear()
  }
  const undoAny = () => (tool === 'smart' && smart.prompts.length ? smart.undo() : undo())

  // ---------- view ----------
  const toScreen = ([x, y]: Point): Point => [x * W * view.z + view.ox, y * H * view.z + view.oy]
  const toNorm = (sx: number, sy: number): Point => [clamp01((sx - view.ox) / view.z / W), clamp01((sy - view.oy) / view.z / H)]
  function fitView() {
    view = fitTo(cw, ch, W, H)
    fitted = true
    draw()
  }
  function zoomAt(f: number, sx = cw / 2, sy = ch / 2) {
    view = zoomView(view, f, sx, sy, fitZoom(cw, ch, W, H))
    fitted = false
    draw()
  }
  function panBy(dx: number, dy: number) {
    view = { ...view, ox: view.ox + dx, oy: view.oy + dy }
    fitted = false
    draw()
  }
  function resize() {
    const r = wrap.getBoundingClientRect()
    cw = r.width
    ch = r.height
    const dpr = devicePixelRatio || 1
    canvas.width = Math.round(cw * dpr)
    canvas.height = Math.round(ch * dpr)
    if (fitted) fitView()
    else draw()
  }

  // ---------- drawing ----------
  let raf = 0
  let hover: Point | null = null // pointer position on the canvas (screen px)
  const draw = () => (raf ||= requestAnimationFrame(paintView))

  function paintView() {
    raf = 0
    const ctx = canvas?.getContext('2d')
    if (!ctx || !cw) return
    const dpr = canvas.width / cw
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)
    const css = getComputedStyle(canvas)
    const tok = (n: string) => css.getPropertyValue(n).trim()
    if (preview !== 'off') {
      ctx.fillStyle = preview === 'green' ? '#00ff00' : preview === 'dark' ? '#101114' : checker(ctx, tok('--surface'), tok('--surface-3'))
      ctx.fillRect(0, 0, cw, ch)
    }
    if (!bitmap) return
    const { z, ox, oy } = view
    const shape = (pts: Point[], close: boolean) => {
      ctx.beginPath()
      for (const p of pts) ctx.lineTo(...toScreen(p))
      if (close) ctx.closePath()
    }
    ctx.imageSmoothingQuality = 'high'
    if (preview !== 'off') {
      ctx.save()
      if (masked) {
        shape(result, true)
        ctx.clip()
      }
      ctx.drawImage(bitmap, ox, oy, W * z, H * z)
      ctx.restore()
      return
    }
    ctx.drawImage(bitmap, ox, oy, W * z, H * z)
    const acc = tok('--acc')
    ctx.lineJoin = 'round'
    if (stroke) {
      ctx.globalAlpha = 0.45
      ctx.drawImage(paintCv, ox, oy, W * z, H * z)
      ctx.globalAlpha = 1
    } else if (masked) {
      shape(result, true)
      ctx.fillStyle = acc
      ctx.globalAlpha = 0.22
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.strokeStyle = 'rgb(0 0 0 / 0.55)'
      ctx.lineWidth = 4
      ctx.stroke()
      ctx.strokeStyle = acc
      ctx.lineWidth = 2
      ctx.stroke()
    }
    // The drawn outline (dashed) while it is open or differs from the shown result.
    if (!stroke && raw.length > 1 && (!closed || smooth || snap)) {
      shape(raw, closed)
      ctx.strokeStyle = 'rgb(255 255 255 / 0.85)'
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.setLineDash([5, 4])
      ctx.strokeStyle = '#111'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (tool === 'polygon') {
      if (!closed && raw.length && hover) {
        ctx.beginPath()
        ctx.moveTo(...toScreen(raw[raw.length - 1]))
        ctx.lineTo(...hover)
        ctx.setLineDash([4, 4])
        ctx.strokeStyle = acc
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.setLineDash([])
      }
      raw.forEach((p, i) => {
        const [x, y] = toScreen(p)
        const s = i === selected ? 5 : 3.5
        ctx.fillStyle = i === selected ? acc : '#fff'
        ctx.strokeStyle = i === selected ? '#fff' : '#111'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        if (!closed && i === 0 && raw.length >= 3) ctx.arc(x, y, 6, 0, Math.PI * 2) // closable first point
        else ctx.rect(x - s, y - s, s * 2, s * 2)
        ctx.fill()
        ctx.stroke()
      })
    } else if (tool === 'brush' && hover && !spaceDown && !panning) {
      ctx.beginPath()
      ctx.arc(hover[0], hover[1], Math.max(2, ((brush / ws) * z) / 2), 0, Math.PI * 2)
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.strokeStyle = erase ? tok('--err-fill') : '#111'
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else if (tool === 'smart') {
      smart.draw(ctx, toScreen, ox, oy, W * z, H * z, erase ? [239, 68, 68] : [34, 197, 94])
    }
  }

  $effect(() => {
    void [result, raw, closed, selected, preview, tool, brush, erase, spaceDown, loaded, smart.prompts, smart.proposal]
    draw()
  })

  // ---------- pointer input ----------
  type Drag =
    | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
    | { kind: 'point'; i: number; committed: boolean }
    | { kind: 'paint' }
    | { kind: 'smart' }
  let drag: Drag | null = null
  const pointers = new Map<number, Point>()
  let pinch: { d: number; mx: number; my: number } | null = null

  const local = (e: MouseEvent): Point => {
    const r = canvas.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  function pinchState() {
    const [a, b] = [...pointers.values()]
    return { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 }
  }
  const hitPoint = (sx: number, sy: number) => pointAt(raw, toScreen, sx, sy)
  const hitEdge = (sx: number, sy: number) => edgeAt(raw, closed, toScreen, sx, sy)

  function down(e: PointerEvent) {
    if (!loaded) return
    canvas.focus()
    canvas.setPointerCapture(e.pointerId)
    const [sx, sy] = local(e)
    pointers.set(e.pointerId, [sx, sy])
    if (pointers.size === 2) {
      stroke = null // a second finger turns a stroke into a pinch
      drag = null
      pinch = pinchState()
      draw()
      return
    }
    if (pointers.size > 2) return
    if (e.button === 1 || spaceDown || (e.button === 0 && preview !== 'off')) {
      e.preventDefault()
      drag = { kind: 'pan', sx, sy, ox: view.ox, oy: view.oy }
      panning = true
      return
    }
    if (e.button === 2) {
      if (tool === 'polygon') removePoint(hitPoint(sx, sy))
      else if (tool === 'smart' && preview === 'off') smart.down(toNorm(sx, sy), sx, sy, 2, false)
      return
    }
    if (e.button !== 0) return
    const p = toNorm(sx, sy)
    if (tool === 'wand') return wand(p)
    if (tool === 'smart') {
      smart.down(p, sx, sy, 0, e.altKey)
      drag = { kind: 'smart' }
      return
    }
    if (tool === 'brush') {
      strokeStart(p)
      drag = { kind: 'paint' }
      return
    }
    const i = hitPoint(sx, sy)
    if (!closed && raw.length >= 3 && (i === 0 || e.detail >= 2)) return closeOutline()
    if (i >= 0) {
      selected = i
      drag = { kind: 'point', i, committed: false }
      return
    }
    const ei = hitEdge(sx, sy)
    if (ei >= 0 && raw.length < MAX_MASK_POINTS) {
      commit()
      raw = [...raw.slice(0, ei + 1), p, ...raw.slice(ei + 1)]
      selected = ei + 1
      drag = { kind: 'point', i: ei + 1, committed: true }
      return
    }
    if (!closed && raw.length < MAX_MASK_POINTS) {
      commit()
      raw = [...raw, p]
      selected = raw.length - 1
      return
    }
    selected = -1
  }

  function move(e: PointerEvent) {
    const [sx, sy] = local(e)
    hover = [sx, sy]
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [sx, sy])
    if (pinch && pointers.size === 2) {
      const n = pinchState()
      zoomAt(n.d / pinch.d, n.mx, n.my)
      panBy(n.mx - pinch.mx, n.my - pinch.my)
      pinch = n
      return
    }
    if (drag?.kind === 'pan') {
      view = { ...view, ox: drag.ox + sx - drag.sx, oy: drag.oy + sy - drag.sy }
      // A plain click (preview mode pans on any press) must not stop the view refitting on resize.
      if (sx !== drag.sx || sy !== drag.sy) fitted = false
    } else if (drag?.kind === 'point') {
      if (!drag.committed) {
        commit()
        drag.committed = true
      }
      raw = raw.with(drag.i, toNorm(sx, sy))
    } else if (drag?.kind === 'paint') {
      strokeTo(toNorm(sx, sy))
    } else if (drag?.kind === 'smart') {
      smart.move(toNorm(sx, sy), sx, sy)
    }
    draw()
  }

  function up(e: PointerEvent) {
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    if (drag?.kind === 'paint') strokeEnd()
    if (drag?.kind === 'smart') smart.up(e.type === 'pointerup')
    drag = null
    draw()
    panning = false
  }

  function leave() {
    hover = null
    draw()
  }

  // ---------- keyboard ----------
  function onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (k === 'Escape') {
      e.preventDefault()
      if (tool === 'smart' && smart.prompts.length) smart.clear()
      else void requestClose()
    } else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) {
      e.preventDefault()
      redo()
    } else if (mod && k === 'z') {
      e.preventDefault()
      undoAny()
    } else if (mod && k === 's') {
      e.preventDefault()
      void save()
    } else if (!mod && (k === '[' || k === ']')) {
      brush = Math.min(128, Math.max(2, brush + (k === ']' ? 4 : -4)))
    } else if (e.target === canvas && !mod) canvasKey(e, k)
  }

  function canvasKey(e: KeyboardEvent, k: string) {
    const step = e.shiftKey ? 10 : 1
    const arrows: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    if (k === ' ') {
      spaceDown = true
    } else if (k === 'Enter') {
      if (tool === 'smart') acceptProposal()
      else closeOutline()
    } else if (k === 'Backspace' && tool === 'smart') {
      if (smart.prompts.length) smart.undo()
    } else if (k === 'Backspace' && !closed && raw.length) {
      removePoint(raw.length - 1)
    } else if ((k === 'Delete' || k === 'Backspace') && selected >= 0) {
      removePoint(selected)
    } else if (k in arrows) {
      const [dx, dy] = arrows[k]
      if (selected >= 0 && tool === 'polygon' && preview === 'off') {
        // Nudges the selected point by screen pixels.
        commit()
        const [x, y] = toScreen(raw[selected])
        raw = raw.with(selected, toNorm(x + dx * step, y + dy * step))
      } else panBy(-dx * 40, -dy * 40)
    } else if (k === '+' || k === '=') {
      zoomAt(1.25)
    } else if (k === '-') {
      zoomAt(0.8)
    } else if (k === '0') {
      fitView()
    } else return
    e.preventDefault()
  }

  // ---------- save / close ----------
  async function save() {
    if (saving || !loaded || !dirty) return
    if (!closed && raw.length >= 3) closed = true
    const has = closed && raw.length >= 3
    const mask: Rig['mask'] = { points: has ? raw : [] }
    if (has && (smooth || snap)) Object.assign(mask, { smoothed: result, smooth: smooth / 100, snap: snap / 100 })
    const next: Rig = { ...base, mask }
    const err = validateRig(next)
    failed = !!err
    status = err ? `Cannot save: ${err}` : ''
    if (err) return
    saving = true
    try {
      base = await api.avatarSave(next)
      clean = key()
      status = 'Saved. The avatar window shows the new cut-out.'
      onSaved(base)
    } catch (e) {
      failed = true
      status = `Saving failed: ${errText(e)}`
    } finally {
      saving = false
    }
  }

  async function revert() {
    if (dirty && !(await ask('Discard your changes and reload the saved mask?', { title: 'Revert mask', kind: 'warning' }))) return
    try {
      load(await api.avatarLoad(base.id))
      failed = false
      status = 'Reloaded the saved mask.'
    } catch (e) {
      failed = true
      status = `Reloading failed: ${errText(e)}`
    }
  }

  async function requestClose() {
    if (
      dirty &&
      !(await ask('Close the mask editor and discard your unsaved changes?', {
        title: 'Unsaved changes',
        kind: 'warning',
        okLabel: 'Discard',
        cancelLabel: 'Keep editing',
      }))
    )
      return
    onClose()
  }

  onMount(() => {
    const prev = document.activeElement as HTMLElement | null
    let alive = true
    ;(async () => {
      try {
        const [fresh, blob] = await Promise.all([api.avatarLoad(rig.id), api.avatarImage(rig)])
        const bmp = await createImageBitmap(blob)
        if (!alive) return bmp.close()
        bitmap = bmp
        setImageSize(bmp.width, bmp.height)
        const c = document.createElement('canvas')
        c.width = ww
        c.height = wh
        const cx = c.getContext('2d', { willReadFrequently: true })!
        cx.imageSmoothingQuality = 'high'
        cx.drawImage(bmp, 0, 0, ww, wh)
        rgba = cx.getImageData(0, 0, ww, wh).data
        const g = new Float32Array(ww * wh)
        for (let i = 0; i < g.length; i++) g[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255
        gray = g
        load(fresh)
        loaded = true
        fitView()
        smart.setImage(bmp, `${fresh.id}:${W}x${H}`, W, H, ww, wh)
        if (tool === 'smart') void smart.start() // picked while the image was loading
      } catch (e) {
        failed = true
        status = `Loading the character failed: ${errText(e)}`
      }
    })()
    canvas.focus()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(Math.exp(-e.deltaY * 0.0015), ...local(e))
    }
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => {
      alive = false
      ro.disconnect()
      canvas.removeEventListener('wheel', wheel)
      cancelAnimationFrame(raf)
      bitmap?.close()
      smart.release() // every way out of the editor frees the model
      prev?.focus()
    }
  })

  const cursor = $derived(
    panning ? 'grabbing' : spaceDown || preview !== 'off' ? 'grab' : tool === 'brush' ? 'none' : 'crosshair',
  )
</script>

<div class="scrim mask-scrim">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (keyboard shortcuts for the whole editor) -->
  <div
    class="dialog mask-ed"
    role="dialog"
    aria-modal="true"
    aria-labelledby="mask-title"
    tabindex="-1"
    onkeydown={onKey}
    onkeyup={(e) => e.key === ' ' && (spaceDown = false)}
  >
    <div class="dlg-head">
      <span class="ico acc"><Icon name="scissors" /></span>
      <h2 id="mask-title">Edit mask: {base.name}</h2>
      <span class="badge" title="Points in the outline that will be saved (at most {MAX_MASK_POINTS})">{masked ? result.length : raw.length} points</span>
      <button type="button" class="icon-only ghost" title="Close the editor (Esc); asks before discarding unsaved changes" aria-label="Close" onclick={requestClose}
        ><Icon name="x" /></button
      >
    </div>

    <div class="bar fit" use:fit role="toolbar" aria-label="Mask tools">
      {#each TOOLS as t (t.id)}
        <Btn icon={t.icon} label={t.label} short={t.short} title={t.title} p={2} aria-pressed={tool === t.id} onclick={() => selectTool(t.id)} />
      {/each}
      <Btn
        icon="eraser"
        label="Erase"
        p={2}
        title={tool === 'polygon' ? 'Erase mode applies to the brush, the magic wand and smart select' : 'Erase mode: the brush, wand or smart select removes from the mask'}
        aria-pressed={erase}
        disabled={tool === 'polygon'}
        onclick={() => (erase = !erase)}
      />
      <span class="sep" aria-hidden="true"></span>
      <Btn
        icon="undo"
        label="Undo"
        title={tool === 'smart' && smart.prompts.length ? 'Remove the last smart select point (Ctrl+Z)' : 'Undo (Ctrl+Z)'}
        disabled={!undoStack.length && !(tool === 'smart' && smart.prompts.length)}
        onclick={undoAny}
      />
      <Btn icon="redo" label="Redo" title="Redo (Ctrl+Y or Ctrl+Shift+Z)" disabled={!redoStack.length} onclick={redo} />
      <Btn icon="trash" label="Clear" title="Remove the whole outline (can be undone)" disabled={!raw.length} onclick={clear} />
      <span class="spacer"></span>
      <button type="button" class="icon-only ghost" title="Zoom out (-)" aria-label="Zoom out" onclick={() => zoomAt(0.8)}><Icon name="zoom-out" /></button>
      <button type="button" class="icon-only ghost" title="Zoom in (+)" aria-label="Zoom in" onclick={() => zoomAt(1.25)}><Icon name="zoom-in" /></button>
      <button type="button" class="icon-only ghost" title="Fit the image into the view (0)" aria-label="Fit to view" onclick={fitView}><Icon name="maximize" /></button>
      <span class="select-wrap prev">
        <select bind:value={preview} aria-label="Preview" title="Preview the cut-out against a background (editing is paused while it is on)">
          <option value="off">Edit</option>
          <option value="checker">Preview: checkerboard</option>
          <option value="green">Preview: green</option>
          <option value="dark">Preview: dark</option>
        </select><Icon name="chev-down" />
      </span>
    </div>

    <div class="opts">
      {#if tool === 'brush'}
        <label class="opt" title="Brush diameter in pixels of the 512 px working copy ([ and ] change it)">
          <span class="label">Size</span>
          <span class="range"><input type="range" min="2" max="128" step="1" bind:value={brush} /><output>{brush}</output></span>
        </label>
      {:else if tool === 'wand'}
        <label class="opt" title="How different a colour may be from the clicked one and still be selected">
          <span class="label">Tolerance</span>
          <span class="range"><input type="range" min="1" max="60" step="1" bind:value={tolerance} /><output>{tolerance}%</output></span>
        </label>
      {:else if tool === 'smart'}
        <SmartSelectBar
          s={smart}
          acceptLabel={erase ? 'Remove' : 'Add'}
          acceptTitle="Merge the proposal into the mask (Enter); with Erase on it is removed"
          onAccept={acceptProposal}
        />
      {/if}
      <label class="opt" title="Rounds corners and removes jitter; the drawn outline is kept until you press Apply">
        <span class="label">Smooth</span>
        <span class="range"
          ><input type="range" min="0" max="100" step="1" value={smooth} oninput={(e) => slide('smooth', +e.currentTarget.value)} onchange={slideDone} /><output
            >{smooth}%</output
          ></span
        >
      </label>
      <label
        class="opt"
        title={`Moves the outline onto the nearest strong edge in the image; higher values search farther (at 100% up to ${SNAP_MAX} px of the 512 px working copy, about ${snapPx} px of this image). For edges farther away, move the points closer first.`}
      >
        <span class="label">Snap to contour</span>
        <span class="range"
          ><input type="range" min="0" max="100" step="1" value={snap} oninput={(e) => slide('snap', +e.currentTarget.value)} onchange={slideDone} /><output
            >{snap}%</output
          ></span
        >
      </label>
      <button
        type="button"
        class="sm"
        title="Make the smoothed and snapped outline the drawn outline and reset both sliders (can be undone)"
        disabled={!masked || (!smooth && !snap)}
        onclick={bake}><Icon name="check" />Apply</button
      >
    </div>

    <p id="mask-hint" class="help hint" title={hint}>{hint}</p>
    <div class="stage" bind:this={wrap}>
      <canvas
        bind:this={canvas}
        tabindex="0"
        aria-label="Mask canvas"
        aria-describedby="mask-hint mask-keys"
        style:cursor
        onpointerdown={down}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={up}
        onpointerleave={leave}
        oncontextmenu={(e) => e.preventDefault()}
      ></canvas>
      {#if !loaded}<div class="stage-msg">{failed ? status : 'Loading image…'}</div>{/if}
    </div>
    <p id="mask-keys" class="vh">
      Keyboard: Enter closes the outline, Backspace removes the last point while drawing, Delete removes the selected
      point, arrow keys move the selected point (with Shift by 10 pixels) or pan, plus and minus zoom, 0 fits the image;
      with smart select Enter adds the proposal, Backspace removes the last point and Escape clears the points;
      hold Space and drag to pan, Ctrl+Z undo, Ctrl+Y redo, Ctrl+S save, Escape closes.
    </p>

    <div class="dlg-foot">
      <span class="msg" role="status">
        {#if failed || (status && !dirty)}<span class={failed ? 'err-text' : 'ok-text'}>{status}</span>
        {:else if warning}<span class="warn"><Icon name="alert" />{warning}</span>{/if}
      </span>
      <button type="button" title="Discard changes and reload the saved mask" disabled={!dirty} onclick={revert}><Icon name="refresh" />Revert</button>
      <button type="button" title="Close the editor (Esc)" onclick={requestClose}>Close</button>
      <button
        type="button"
        class="primary"
        title={dirty ? 'Save the mask (Ctrl+S); the avatar window updates' : 'Nothing to save'}
        disabled={!dirty || saving}
        onclick={save}><Icon name="check" />{saving ? 'Saving…' : 'Save'}</button
      >
    </div>
  </div>
</div>

<style>
  .mask-scrim {
    padding: 12px;
  }
  .mask-ed {
    width: 100%;
    height: 100%;
    max-width: 1600px;
  }
  .mask-ed .dlg-head {
    padding: 10px 12px 6px 16px;
  }
  .bar {
    margin: 0 13px;
  }
  .sep {
    width: 1px;
    height: 20px;
    background: var(--border);
    flex: none;
  }
  .prev {
    flex: 0 1 128px;
    min-width: 84px; /* shrinks before the buttons collapse; 'Edit' still fits */
  }
  .opts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 16px;
    padding: 6px 16px;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 170px;
    min-width: 0;
  }
  .opt .label {
    white-space: nowrap;
  }
  .opt .range {
    flex: 1;
  }

  .hint {
    padding: 0 16px 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 140px;
    margin: 0 16px;
    border: 1px solid var(--border);
    border-radius: var(--r);
    overflow: hidden;
    background: var(--surface-2);
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
  }
  canvas:focus-visible {
    outline-offset: -2px;
  }
  .stage-msg {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 16px;
    text-align: center;
    color: var(--text-3);
  }
  .mask-ed .dlg-foot {
    margin-top: 10px;
    align-items: center;
  }
  .msg {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
  }
  .warn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--busy);
  }
</style>

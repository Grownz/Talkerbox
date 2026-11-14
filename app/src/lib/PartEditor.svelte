<script lang="ts">
  // Part editor: outline eyes, mouth, limbs and other parts as polygons with pivots, and preview the animation
  // with the shared renderer (rigRender.ts). Viewing controls match the mask editor (canvasView.ts).
  import { ask } from '@tauri-apps/plugin-dialog'
  import { onMount } from 'svelte'
  import { api, errText } from './api'
  import Btn from './Btn.svelte'
  import { checker, hitEdge, hitPoint, ImageView } from './canvasView'
  import { fit } from './fit'
  import { History } from './history.svelte'
  import Icon from './Icon.svelte'
  import { pointInPolygon } from './maskGeometry'
  import {
    DEFAULT_WARP,
    MAX_PARTS,
    MAX_POLYGON_POINTS,
    deriveKind,
    maskOutline,
    validateRig,
    wouldLoop,
    type PartRole,
    type Point,
    type FillMode,
    type Rig,
    type RigFill,
    type RigMouth,
    type RigPart,
  } from './rig'
  import { autoSplit } from './mouthWarp'
  import { DEFAULT_LID, DEFAULT_MOUTH, LIMB_ROLES, REST, bbox, defaultPivot, drawRig, rigMouthGeo, sampleRing, type Pose } from './rigRender'
  import { VISEMES, type Viseme } from './viseme'
  import { maskToPolygon } from './smartSelect'
  import AiFillPanel from './AiFillPanel.svelte'
  import type { AiFill } from './aiFill'
  import { fillPolygons, regionSig } from './fillUnder'
  import SmartSelectBar from './SmartSelectBar.svelte'
  import { SmartSession } from './smartSession.svelte'
  import FacePanel from './FacePanel.svelte'
  import { faceParts } from './faceParts'

  let { rig, onClose, onSaved }: { rig: Rig; onClose: () => void; onSaved: (r: Rig) => void } = $props()

  type EPart = { id: string; role: PartRole; label: string; polygon: Point[]; closed: boolean; pivot: Point | null; parent: string; lid: string }
  /** Extra outlines of the mouth part: the open-mouth shape and the two lips. */
  type Sub = 'interior' | 'lipUpper' | 'lipLower'
  type Subs = Record<Sub, { pts: Point[]; closed: boolean }>
  /** Background under moved parts: mode, AI result (area, parts signature, image; `png` when not saved yet, `stored`
   * when the saved character has one). */
  type FillState = { mode: FillMode; rect: [number, number, number, number] | null; sig: string | null; img: ImageBitmap | null; png: Blob | null; stored: boolean }
  const NO_FILL: FillState = { mode: 'none', rect: null, sig: null, img: null, png: null, stored: false }
  type Snapshot = { parts: EPart[]; subs: Subs; corners: [Point, Point] | null; mouthColor: string; warp: number; fill: FillState }
  const NO_SUBS: Subs = { interior: { pts: [], closed: false }, lipUpper: { pts: [], closed: false }, lipLower: { pts: [], closed: false } }
  const SUB: Record<Sub, { what: string; colour: string }> = {
    interior: { what: 'the open mouth (the dark inside when the mouth is open)', colour: '#ffffff' },
    lipUpper: { what: 'the upper lip', colour: '#fde047' },
    lipLower: { what: 'the lower lip', colour: '#67e8f9' },
  }
  const WORK = 512 // long side of the copy used for colour sampling
  const ROLES: { role: PartRole; label: string; colour: string }[] = [
    { role: 'eyeL', label: 'Left eye', colour: '#38bdf8' },
    { role: 'eyeR', label: 'Right eye', colour: '#38bdf8' },
    { role: 'mouth', label: 'Mouth', colour: '#f43f5e' },
    { role: 'armL', label: 'Left arm', colour: '#84cc16' },
    { role: 'armR', label: 'Right arm', colour: '#84cc16' },
    { role: 'handL', label: 'Left hand', colour: '#facc15' },
    { role: 'handR', label: 'Right hand', colour: '#facc15' },
    { role: 'legL', label: 'Left leg', colour: '#c084fc' },
    { role: 'legR', label: 'Right leg', colour: '#c084fc' },
    { role: 'head', label: 'Head', colour: '#fb923c' },
    { role: 'body', label: 'Body', colour: '#fb923c' },
    { role: 'custom', label: 'Custom', colour: '#94a3b8' },
  ]
  const roleInfo = (r: PartRole) => ROLES.find((x) => x.role === r)!
  const nameOf = (p: EPart) => p.label.trim() || roleInfo(p.role).label
  const isEye = (r: PartRole) => r === 'eyeL' || r === 'eyeR'
  const POSE_LABEL: Record<(typeof LIMB_ROLES)[number], string> = { armL: 'Left arm', armR: 'Right arm', legL: 'Left leg', legR: 'Right leg' }

  // svelte-ignore state_referenced_locally
  let W = rig.image.width
  // svelte-ignore state_referenced_locally
  let H = rig.image.height

  // svelte-ignore state_referenced_locally
  let base = $state.raw(rig)
  let parts = $state.raw<EPart[]>([])
  let subs = $state.raw<Subs>(NO_SUBS)
  let corners = $state.raw<[Point, Point] | null>(null)
  let warp = $state(DEFAULT_WARP)
  let fill = $state.raw<FillState>(NO_FILL)
  let viseme = $state<Viseme>('closed')
  let mouthColor = $state(DEFAULT_MOUTH)
  let selId = $state<string | null>(null)
  let target = $state<'polygon' | Sub>('polygon')
  let selPoint = $state(-1)
  let hidden = $state.raw<Set<string>>(new Set())
  let newRole = $state<PartRole>('eyeL')
  let preview = $state<'off' | 'checker' | 'green' | 'dark'>('off')
  let pose = $state.raw<Pose>(REST)
  let playing = $state(false)
  let clean = $state('')
  let status = $state('')
  let failed = $state(false)
  let saving = $state(false)
  let loaded = $state(false)
  let spaceDown = $state(false)
  let panning = $state(false)
  let bitmap: ImageBitmap | null = null
  let rgba: Uint8ClampedArray | null = null
  let ww = 1
  let wh = 1
  // "Pick with Smart select": the role being picked (null when off); proposals come at the 512 px working size.
  const smart = new SmartSession()
  let picking = $state<PartRole | null>(null)
  /** Offer Auto-split right after a mouth was created with Smart select. */
  let offerSplit = $state(false)
  // "Detect face": panel open, and the note on the last detection with the undo depth right after it (its Undo
  // button only shows while that detection is still the last step).
  let faceOpen = $state(false)
  let faceNote = $state<{ text: string; at: number } | null>(null)

  let canvas: HTMLCanvasElement
  let wrap: HTMLDivElement
  const vp = new ImageView(() => [W, H], () => draw())

  const sel = $derived(parts.find((p) => p.id === selId) ?? null)
  const sub = $derived(target !== 'polygon' && sel?.role === 'mouth' ? target : null)
  const editPts = $derived(sub ? subs[sub].pts : (sel?.polygon ?? []))
  const editClosed = $derived(sub ? subs[sub].closed : !!sel?.closed)
  const hasLips = $derived(subs.lipUpper.closed && subs.lipLower.closed)
  const free = $derived(ROLES.filter((r) => r.role === 'custom' || !parts.some((p) => p.role === r.role)))
  const kind = $derived(deriveKind(parts.filter((p) => p.closed)))
  const outline = $derived(maskOutline(base))
  const limbs = $derived(LIMB_ROLES.filter((r) => parts.some((p) => p.role === r && p.closed)))
  const key = () => JSON.stringify([parts, subs, corners, mouthColor, warp, fill.mode, fill.rect, fill.sig, !!fill.png])
  const dirty = $derived(loaded && key() !== clean)

  $effect(() => {
    if (!free.some((r) => r.role === newRole)) newRole = free[0]?.role ?? 'custom'
  })

  /** The rig as it would be saved; `strict` reports unfinished outlines instead of leaving them out. */
  function build(strict: boolean): { rig: Rig; error: string | null } {
    const done = parts.filter((p) => p.closed && p.polygon.length >= 3)
    const open = parts.find((p) => !done.includes(p))
    let error = strict && open ? `"${nameOf(open)}" is not finished: close its outline or delete it` : null
    const ids = new Set(done.map((p) => p.id))
    const out: RigPart[] = done.map((p, i) => {
      const r: RigPart = { id: p.id, role: p.role, polygon: p.polygon, pivot: p.pivot ?? defaultPivot(p.role, p.polygon), z: i }
      if (p.parent && ids.has(p.parent)) r.parent = p.parent
      const l = p.label.trim()
      if (l && l !== roleInfo(p.role).label) r.label = l
      if (isEye(p.role) && p.lid) r.lid = p.lid
      return r
    })
    let mouth: RigMouth | undefined = base.mouth?.states.length ? { states: base.mouth.states } : undefined
    if (out.some((p) => p.role === 'mouth')) {
      mouth = { states: base.mouth?.states ?? [], color: mouthColor }
      const done = (k: Sub) => (subs[k].closed && subs[k].pts.length >= 3 ? subs[k].pts : null)
      const inner = done('interior')
      if (inner) mouth.interior = inner
      else if (strict && subs.interior.pts.length) error ??= 'The open mouth shape is not finished: close it or clear it'
      const up = done('lipUpper')
      const low = done('lipLower')
      if (up && low) {
        mouth.lipUpper = up
        mouth.lipLower = low
        if (corners) mouth.corners = corners
        mouth.warp = Math.round(warp * 100) / 100
      } else if (strict && (subs.lipUpper.pts.length || subs.lipLower.pts.length))
        error ??= 'Lips: outline and close both the upper and the lower lip, or clear them'
    }
    let rigFill: RigFill | undefined
    if (fill.mode !== 'none') {
      rigFill = { mode: fill.mode }
      if (fill.mode === 'ai' && fill.rect && (fill.png || fill.stored)) Object.assign(rigFill, { image: 'fill.png', rect: fill.rect, sig: fill.sig ?? undefined })
    }
    return { rig: { ...base, parts: out, mouth, fill: rigFill, kind: deriveKind(out) }, error }
  }
  const draft = $derived.by(() => build(false).rig)
  const fillPolys = $derived(fillPolygons(draft.parts))
  const aiState = $derived(!fill.rect ? 'none' : fill.sig === regionSig(fillPolys) ? 'ready' : 'stale')

  const warning = $derived.by(() => {
    if (!parts.length) return 'No parts yet: choose a role, press Add, then click points around that part.'
    const open = parts.find((p) => !p.closed)
    if (open) return `"${nameOf(open)}" is open: click its first point, double-click or press Enter to close it.`
    if (!outline) return 'No mask yet: edit the mask first for a clean cut-out (parts work without one).'
    const out = parts.find((p) => p.polygon.some((q) => !pointInPolygon(q, outline)))
    if (out) return `"${nameOf(out)}" reaches outside the mask; that area is cut off in the avatar.`
    const mouth = parts.find((p) => p.role === 'mouth')
    if (mouth && subs.interior.pts.some((q) => !pointInPolygon(q, mouth.polygon))) return 'The open mouth shape reaches outside the mouth; it is cut off there.'
    if (mouth && subs.lipUpper.closed !== subs.lipLower.closed) return 'Only one lip is outlined: the lips move once both are closed (or use Auto-split).'
    if (mouth && [...subs.lipUpper.pts, ...subs.lipLower.pts].some((q) => !pointInPolygon(q, outline)))
      return 'A lip reaches outside the mask; that part of the lip is cut off in the avatar.'
    if (mouth && hasLips && !rigMouthGeo(draft, W, H)) return 'The lips are too small or too narrow to move; the mouth opens with the open shape instead.'
    return ''
  })
  const hint = $derived(
    picking && preview === 'off'
      ? `Click the ${roleInfo(picking).label.toLowerCase()} on the image; right-click or Alt+click marks what does not belong to it, drag to draw a box around it. Enter or "Create" makes it a part; Esc cancels.`
      : preview !== 'off'
      ? 'Preview: move the sliders or press Play demo; drag to pan. Switch the preview off to edit.'
      : !sel
        ? 'Add a part with the role menu, or click a part on the image to select it.'
        : !editClosed
          ? `Click points around ${sub ? SUB[sub].what : nameOf(sel)}; click the first point, double-click or press Enter to close. Backspace removes the last point.`
          : sub
            ? `Drag points of ${SUB[sub].what}, click an edge to insert one; right-click or Delete removes a point.`
            : 'Drag points or the pivot crosshair (the point the part turns about); click an edge to insert a point; right-click or Delete removes one. Click another part to select it.',
  )

  let fillLoad = 0
  function load(r: Rig) {
    base = r
    parts = [...r.parts]
      .sort((a, b) => a.z - b.z)
      .map((p) => ({ id: p.id, role: p.role, label: p.label ?? '', polygon: p.polygon, closed: true, pivot: p.pivot, parent: p.parent ?? '', lid: p.lid ?? '' }))
    const one = (pts?: Point[]) => ({ pts: pts ?? [], closed: (pts?.length ?? 0) >= 3 })
    subs = { interior: one(r.mouth?.interior), lipUpper: one(r.mouth?.lipUpper), lipLower: one(r.mouth?.lipLower) }
    corners = r.mouth?.corners ?? null
    warp = r.mouth?.warp ?? DEFAULT_WARP
    mouthColor = r.mouth?.color ?? DEFAULT_MOUTH
    fill = { ...NO_FILL, mode: r.fill?.mode ?? 'none', rect: r.fill?.rect ?? null, sig: r.fill?.sig ?? null, stored: !!r.fill?.image }
    // The stored AI fill for the preview (not part of the undo key; a failed read shows the classic fill).
    const token = ++fillLoad
    if (r.fill?.image)
      void api
        .avatarFill(r.id)
        .then(createImageBitmap)
        .then((img) => {
          // A newer load, a new fill or a closed editor drops it: free the bitmap right away.
          if (token === fillLoad && fill.stored && !fill.png) fill = { ...fill, img }
          else img.close()
        }, () => {})
    if (!parts.some((p) => p.id === selId)) selId = parts[0]?.id ?? null
    target = 'polygon'
    selPoint = -1
    history.clear()
    clean = key()
  }

  // ---------- history ----------
  const history = new History<Snapshot>(
    () => ({ parts, subs, corners, mouthColor, warp, fill }),
    (s) => {
      ;({ parts, subs, corners, mouthColor, warp, fill } = s)
      if (!parts.some((p) => p.id === selId)) selId = parts[0]?.id ?? null
      selPoint = -1
    },
  )
  const commit = () => history.commit()
  function setFillMode(mode: FillMode) {
    commit()
    fill = { ...fill, mode }
    if (preview === 'off' && mode !== 'none') preview = 'checker'
  }
  function aiResult(r: AiFill) {
    commit()
    fill = { ...fill, rect: r.rect, sig: regionSig(fillPolys), img: r.img, png: r.png }
    if (preview === 'off') preview = 'checker'
  }

  /** While picking, Undo removes the last Smart select point first. */
  const undoAny = () => (picking && smart.prompts.length ? smart.undo() : undo())
  const undo = () => history.undo()
  const redo = () => history.redo()
  // A colour-picker drag is one undo step, pushed when it ends.
  const begin = () => history.begin()
  const end = () => history.end()

  // ---------- edits ----------
  const update = (id: string, f: (p: EPart) => EPart) => (parts = parts.map((p) => (p.id === id ? f(p) : p)))
  function setPts(pts: Point[], closed = editClosed) {
    if (sub) {
      subs = { ...subs, [sub]: { pts, closed: closed && pts.length >= 3 } }
      if (sub !== 'interior') corners = null // hand-edited lips: the corners follow the lips again
    } else if (sel) update(sel.id, (p) => ({ ...p, polygon: pts, closed: closed && pts.length >= 3 }))
  }
  /** Upper and lower lip from the mouth outline, split along the line between its leftmost and rightmost points. */
  function splitLips() {
    const mouth = parts.find((p) => p.role === 'mouth' && p.closed)
    const s = mouth && autoSplit(mouth.polygon)
    if (!s) return
    commit()
    subs = { ...subs, lipUpper: { pts: s.upper, closed: true }, lipLower: { pts: s.lower, closed: true } }
    corners = s.corners
    target = 'polygon'
    selPoint = -1
  }
  function sample(p: EPart): string {
    if (!rgba || p.polygon.length < 3) return p.lid
    return sampleRing(rgba, ww, wh, p.polygon.map(([x, y]): Point => [x * ww, y * wh])) ?? p.lid
  }
  function closeEdit() {
    if (editClosed || editPts.length < 3) return
    commit()
    setPts(editPts, true)
    if (!sub && sel)
      update(sel.id, (p) => ({ ...p, pivot: p.pivot ?? defaultPivot(p.role, p.polygon), lid: isEye(p.role) && !p.lid ? sample(p) : p.lid }))
  }
  function removePoint(i: number) {
    if (i < 0 || i >= editPts.length) return
    commit()
    setPts(editPts.filter((_, j) => j !== i))
    selPoint = -1
  }
  function clearOutline() {
    if (!editPts.length) return
    commit()
    setPts([], false)
    if (!sub && sel) update(sel.id, (p) => ({ ...p, pivot: null }))
    selPoint = -1
  }
  function newId(role: PartRole): string {
    const b = role.replace(/[LR]$/, (m) => '-' + m.toLowerCase())
    if (!parts.some((p) => p.id === b)) return b
    for (let i = 2; ; i++) if (!parts.some((p) => p.id === `${b}-${i}`)) return `${b}-${i}`
  }
  function addPart() {
    if (parts.length >= MAX_PARTS || !free.some((r) => r.role === newRole)) return
    commit()
    const role = newRole
    // A hand hangs on the arm of the same side when there is one.
    const arm = /^hand/.test(role) ? parts.find((p) => p.role === role.replace('hand', 'arm')) : undefined
    const p: EPart = { id: newId(role), role, label: '', polygon: [], closed: false, pivot: null, parent: arm?.id ?? '', lid: '' }
    parts = [...parts, p]
    select(p.id)
    preview = 'off'
    canvas.focus()
  }
  /** Starts picking a part of the chosen role with Smart select (same limits as Add). */
  function startPick() {
    if (parts.length >= MAX_PARTS || !free.some((r) => r.role === newRole)) return
    picking = newRole
    offerSplit = false
    preview = 'off'
    selPoint = -1
    void smart.start()
    canvas.focus()
  }
  function stopPick() {
    picking = null
    smart.clear()
  }
  /** Turns the proposal into a closed part of the picked role with the default pivot (and parent, as Add does). */
  function acceptPick() {
    const role = picking
    if (!role || !smart.proposal || parts.length >= MAX_PARTS || !free.some((r) => r.role === role)) return
    const polygon = maskToPolygon(smart.proposal, ww, wh, MAX_POLYGON_POINTS)
    if (!polygon) return void (smart.err = 'The proposal is too small to outline; add a point or a box.')
    commit()
    const arm = /^hand/.test(role) ? parts.find((q) => q.role === role.replace('hand', 'arm')) : undefined
    const p: EPart = { id: newId(role), role, label: '', polygon, closed: true, pivot: defaultPivot(role, polygon), parent: arm?.id ?? '', lid: '' }
    if (isEye(role)) p.lid = sample(p)
    parts = [...parts, p]
    select(p.id)
    stopPick()
    offerSplit = role === 'mouth'
  }
  /** Adds the detected eyes and mouth (with lips and corners) as one undo step; roles that already have a part keep it. */
  function applyFace(points: Point[]) {
    const f = faceParts(points)
    if (!f) return void (faceNote = { text: 'The face found is too small to outline.', at: -1 })
    const found: [PartRole, Point[]][] = [['eyeR', f.eyeR], ['eyeL', f.eyeL], ['mouth', f.mouth]]
    const add = found.filter(([r]) => !parts.some((p) => p.role === r))
    const kept = found.filter(([r]) => !add.some(([a]) => a === r)).map(([r]) => roleInfo(r).label.toLowerCase())
    if (!add.length) return void (faceNote = { text: 'Both eyes and the mouth already exist; delete the ones to detect again.', at: -1 })
    if (parts.length + add.length > MAX_PARTS) return void (faceNote = { text: `At most ${MAX_PARTS} parts.`, at: -1 })
    commit()
    const made = add.map(([role, polygon]): EPart => {
      const p: EPart = { id: newId(role), role, label: '', polygon, closed: true, pivot: defaultPivot(role, polygon), parent: '', lid: '' }
      if (isEye(role)) p.lid = sample(p)
      return p
    })
    parts = [...parts, ...made]
    if (made.some((p) => p.role === 'mouth')) {
      subs = { ...subs, lipUpper: { pts: f.lipUpper, closed: true }, lipLower: { pts: f.lipLower, closed: true } }
      corners = f.corners
    }
    select(made.at(-1)!.id)
    preview = 'off'
    const names = made.map((p) => roleInfo(p.role).label.toLowerCase()).join(', ')
    faceNote = { text: `Added ${names}${made.some((p) => p.role === 'mouth') ? ' with both lips' : ''}${kept.length ? `; kept your ${kept.join(', ')}` : ''}. Check the outlines and drag points to fit.`, at: history.undoStack.length }
  }

  const pickColour = (r: PartRole): [number, number, number] => {
    const h = roleInfo(r).colour
    return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
  }

  function select(id: string) {
    selId = id
    target = 'polygon'
    selPoint = -1
  }
  function deletePart(id: string) {
    commit()
    const gone = parts.find((p) => p.id === id)
    parts = parts.filter((p) => p.id !== id).map((p) => (p.parent === id ? { ...p, parent: '' } : p))
    if (gone?.role === 'mouth') {
      subs = NO_SUBS
      corners = null
    }
    selId = parts[0]?.id ?? null
    target = 'polygon'
    selPoint = -1
  }
  function movePart(id: string, d: -1 | 1) {
    const i = parts.findIndex((p) => p.id === id)
    const j = i + d
    if (i < 0 || j < 0 || j >= parts.length) return
    commit()
    const next = parts.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    parts = next
  }
  function setField<K extends 'label' | 'parent' | 'lid'>(id: string, k: K, v: EPart[K]) {
    commit()
    update(id, (p) => ({ ...p, [k]: v }))
  }
  function resetPivot(id: string) {
    commit()
    update(id, (p) => ({ ...p, pivot: defaultPivot(p.role, p.polygon) }))
  }
  function toggleHidden(id: string) {
    const h = new Set(hidden)
    if (!h.delete(id)) h.add(id)
    hidden = h
  }

  // ---------- preview ----------
  let playRaf = 0
  function stopPlay() {
    cancelAnimationFrame(playRaf)
    playing = false
  }
  function togglePlay() {
    if (playing) return stopPlay()
    playing = true
    if (preview === 'off') preview = 'checker'
    const t0 = performance.now()
    const step = (t: number) => {
      const s = (t - t0) / 1000
      const b = s % 3.2
      pose = {
        mouth: Math.max(0, Math.sin(s * 8)) * (0.6 + 0.4 * Math.sin(s * 1.3)),
        // Steps through round, neutral and wide shapes (one per syllable), as speech does.
        wide: [0, 1, -1, 0.4, -0.6, 0.8][Math.floor((s * 8) / (2 * Math.PI)) % 6],
        blink: b < 0.16 ? Math.sin((b / 0.16) * Math.PI) : 0,
        armL: 25 * Math.sin(s * 1.7),
        armR: -25 * Math.sin(s * 1.7 + 0.6),
        legL: 12 * Math.sin(s * 1.2),
        legR: -12 * Math.sin(s * 1.2),
        sway: 1.5 * Math.sin(s * 0.9),
      }
      playRaf = requestAnimationFrame(step)
    }
    playRaf = requestAnimationFrame(step)
  }
  function setPose(k: keyof Pose, v: number) {
    stopPlay()
    if (preview === 'off') preview = 'checker'
    pose = { ...pose, [k]: v }
  }
  function editSub(k: Sub) {
    target = sub === k ? 'polygon' : k
    selPoint = -1
    preview = 'off'
  }
  function setViseme(v: Viseme) {
    viseme = v
    stopPlay()
    if (preview === 'off') preview = 'checker'
    pose = { ...pose, mouth: VISEMES[v].open, wide: VISEMES[v].wide }
  }
  function resetPose() {
    stopPlay()
    viseme = 'closed'
    pose = REST
  }

  // ---------- view ----------
  const { toScreen, toNorm } = vp
  const fitView = () => vp.fit()
  const zoomAt = (f: number, sx?: number, sy?: number) => vp.zoomAt(f, sx, sy)
  const panBy = (dx: number, dy: number) => vp.panBy(dx, dy)
  const resize = () => vp.resize(wrap, canvas)

  // ---------- drawing ----------
  let raf = 0
  let hover: Point | null = null
  const draw = () => (raf ||= requestAnimationFrame(paintView))
  const pivotOf = (p: EPart) => p.pivot ?? defaultPivot(p.role, p.polygon)

  function paintView() {
    raf = 0
    const ctx = canvas?.getContext('2d')
    const { cw, ch } = vp
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
    const { z, ox, oy } = vp.view
    ctx.imageSmoothingQuality = 'high'
    if (preview !== 'off') {
      ctx.save()
      ctx.transform(z, 0, 0, z, ox, oy)
      drawRig(ctx, draft, bitmap, W, H, pose, undefined, fill.img)
      ctx.restore()
      return
    }
    ctx.drawImage(bitmap, ox, oy, W * z, H * z)
    const acc = tok('--acc')
    const shape = (pts: Point[], close: boolean) => {
      ctx.beginPath()
      for (const p of pts) ctx.lineTo(...toScreen(p))
      if (close) ctx.closePath()
    }
    const outlineStroke = (colour: string, width: number, dash: number[] = []) => {
      ctx.setLineDash(dash)
      ctx.strokeStyle = 'rgb(0 0 0 / 0.55)'
      ctx.lineWidth = width + 2
      ctx.stroke()
      ctx.strokeStyle = colour
      ctx.lineWidth = width
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.lineJoin = 'round'
    if (outline) {
      shape(outline, true)
      outlineStroke('rgb(255 255 255 / 0.7)', 1, [6, 5])
    }
    ctx.font = `600 12px ${css.fontFamily}`
    ctx.textAlign = 'center'
    for (const p of parts) {
      const me = p.id === selId
      if (!me && (hidden.has(p.id) || p.polygon.length < 2)) continue
      const colour = roleInfo(p.role).colour
      shape(p.polygon, p.closed)
      if (p.closed) {
        ctx.fillStyle = colour
        ctx.globalAlpha = me ? 0.28 : 0.18
        ctx.fill()
        ctx.globalAlpha = 1
      }
      outlineStroke(me ? acc : colour, me ? 2 : 1.5)
      if (p.closed && !me) {
        // Label just above the part.
        const b = bbox(p.polygon)
        const [x, y] = toScreen([(b.x0 + b.x1) / 2, b.y0])
        ctx.lineWidth = 3
        ctx.strokeStyle = '#111'
        ctx.strokeText(nameOf(p), x, y - 6)
        ctx.fillStyle = '#fff'
        ctx.fillText(nameOf(p), x, y - 6)
      }
    }
    const mouth = parts.find((p) => p.role === 'mouth')
    if (mouth && (mouth.id === selId || !hidden.has(mouth.id))) {
      for (const k of ['lipUpper', 'lipLower', 'interior'] as Sub[]) {
        const { pts, closed } = subs[k]
        if (pts.length < 2) continue
        shape(pts, closed)
        if (closed) {
          ctx.fillStyle = k === 'interior' ? mouthColor : SUB[k].colour
          ctx.globalAlpha = k === 'interior' ? 0.5 : 0.22
          ctx.fill()
          ctx.globalAlpha = 1
        }
        outlineStroke(sub === k ? acc : SUB[k].colour, 1.5, [4, 3])
      }
      // Mouth corners (from Auto-split): the line the lips part along.
      for (const c of corners ?? []) {
        const [x, y] = toScreen(c)
        ctx.beginPath()
        ctx.arc(x, y, 4, 0, Math.PI * 2)
        outlineStroke('#fff', 1.5)
      }
    }
    if (picking) return smart.draw(ctx, toScreen, ox, oy, W * z, H * z, pickColour(picking))
    if (!sel) return
    if (!editClosed && editPts.length && hover) {
      ctx.beginPath()
      ctx.moveTo(...toScreen(editPts[editPts.length - 1]))
      ctx.lineTo(...hover)
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = acc
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.setLineDash([])
    }
    editPts.forEach((p, i) => {
      const [x, y] = toScreen(p)
      const s = i === selPoint ? 5 : 3.5
      ctx.fillStyle = i === selPoint ? acc : '#fff'
      ctx.strokeStyle = i === selPoint ? '#fff' : '#111'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      if (!editClosed && i === 0 && editPts.length >= 3) ctx.arc(x, y, 6, 0, Math.PI * 2)
      else ctx.rect(x - s, y - s, s * 2, s * 2)
      ctx.fill()
      ctx.stroke()
    })
    if (sel.closed && !sub) {
      // Pivot crosshair.
      const [x, y] = toScreen(pivotOf(sel))
      ctx.beginPath()
      ctx.moveTo(x - 11, y)
      ctx.lineTo(x + 11, y)
      ctx.moveTo(x, y - 11)
      ctx.lineTo(x, y + 11)
      ctx.moveTo(x + 5, y)
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      outlineStroke(acc, 2)
    }
  }

  $effect(() => {
    void [parts, subs, corners, warp, mouthColor, fill, selId, selPoint, target, hidden, preview, pose, spaceDown, loaded, picking, smart.prompts, smart.proposal]
    draw()
  })

  // ---------- pointer input ----------
  type Drag =
    | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
    | { kind: 'point'; i: number; committed: boolean }
    | { kind: 'pivot'; committed: boolean }
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

  function down(e: PointerEvent) {
    if (!loaded) return
    canvas.focus()
    canvas.setPointerCapture(e.pointerId)
    const [sx, sy] = local(e)
    pointers.set(e.pointerId, [sx, sy])
    if (pointers.size === 2) {
      drag = null
      pinch = pinchState()
      return
    }
    if (pointers.size > 2) return
    if (e.button === 1 || spaceDown || (e.button === 0 && preview !== 'off')) {
      e.preventDefault()
      drag = { kind: 'pan', sx, sy, ox: vp.view.ox, oy: vp.view.oy }
      panning = true
      return
    }
    if (picking && preview === 'off') {
      smart.down(toNorm(sx, sy), sx, sy, e.button, e.altKey)
      if (e.button === 0) drag = { kind: 'smart' }
      return
    }
    if (e.button === 2) return removePoint(hitPoint(editPts, toScreen, sx, sy))
    if (e.button !== 0) return
    const p = toNorm(sx, sy)
    if (sel) {
      if (sel.closed && !sub) {
        const [px, py] = toScreen(pivotOf(sel))
        if (Math.hypot(px - sx, py - sy) <= 10) {
          drag = { kind: 'pivot', committed: false }
          return
        }
      }
      const i = hitPoint(editPts, toScreen, sx, sy)
      if (!editClosed && editPts.length >= 3 && (i === 0 || e.detail >= 2)) return closeEdit()
      if (i >= 0) {
        selPoint = i
        drag = { kind: 'point', i, committed: false }
        return
      }
      const ei = hitEdge(editPts, editClosed, toScreen, sx, sy)
      if (ei >= 0 && editPts.length < MAX_POLYGON_POINTS) {
        commit()
        setPts([...editPts.slice(0, ei + 1), p, ...editPts.slice(ei + 1)])
        selPoint = ei + 1
        drag = { kind: 'point', i: ei + 1, committed: true }
        return
      }
      if (!editClosed) {
        if (editPts.length >= MAX_POLYGON_POINTS) return
        commit()
        setPts([...editPts, p], false)
        selPoint = editPts.length - 1
        return
      }
    }
    // Click on a part (topmost first) selects it.
    const hit = [...parts].reverse().find((q) => q.closed && (q.id === selId || !hidden.has(q.id)) && pointInPolygon(p, q.polygon))
    if (hit && hit.id !== selId) select(hit.id)
    else selPoint = -1
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
      vp.view = { ...vp.view, ox: drag.ox + sx - drag.sx, oy: drag.oy + sy - drag.sy }
      // A plain click (preview mode pans on any press) must not stop the view refitting on resize.
      if (sx !== drag.sx || sy !== drag.sy) vp.fitted = false
    } else if (drag?.kind === 'smart') {
      smart.move(toNorm(sx, sy), sx, sy)
    } else if (drag && sel) {
      if (!drag.committed) {
        commit()
        drag.committed = true
      }
      const p = toNorm(sx, sy)
      if (drag.kind === 'pivot') update(sel.id, (q) => ({ ...q, pivot: p }))
      else setPts(editPts.with(drag.i, p))
    }
    draw()
  }

  function up(e: PointerEvent) {
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    if (drag?.kind === 'smart') smart.up(e.type === 'pointerup')
    drag = null
    panning = false
    draw()
  }

  // ---------- keyboard ----------
  function onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const typing = e.target instanceof HTMLInputElement && e.target.type === 'text'
    if (k === 'Escape') {
      e.preventDefault()
      if (picking && smart.prompts.length) smart.clear()
      else if (picking) stopPick()
      else void requestClose()
    } else if (mod && k === 's') {
      e.preventDefault()
      void save()
    } else if (typing) {
      return // text fields keep their own undo
    } else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) {
      e.preventDefault()
      redo()
    } else if (mod && k === 'z') {
      e.preventDefault()
      undoAny()
    } else if (e.target === canvas && !mod) canvasKey(e, k)
  }

  function canvasKey(e: KeyboardEvent, k: string) {
    const step = e.shiftKey ? 10 : 1
    const arrows: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    if (k === ' ') {
      spaceDown = true
    } else if (k === 'Enter') {
      if (picking) acceptPick()
      else closeEdit()
    } else if (k === 'Backspace' && picking) {
      if (smart.prompts.length) smart.undo()
    } else if (k === 'Backspace' && !editClosed && editPts.length) {
      removePoint(editPts.length - 1)
    } else if ((k === 'Delete' || k === 'Backspace') && selPoint >= 0) {
      removePoint(selPoint)
    } else if (k in arrows) {
      const [dx, dy] = arrows[k]
      if (selPoint >= 0 && selPoint < editPts.length && preview === 'off') {
        commit()
        const [x, y] = toScreen(editPts[selPoint])
        setPts(editPts.with(selPoint, toNorm(x + dx * step, y + dy * step)))
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
    const { rig: next, error } = build(true)
    const err = error ?? validateRig(next)
    failed = !!err
    status = err ? `Cannot save: ${err}` : ''
    if (err) return
    saving = true
    try {
      if (fill.png && next.fill?.image) await api.avatarSaveFill(base.id, fill.png)
      const saved = await api.avatarSave(next)
      load(saved)
      status = 'Saved. The avatar window reloads the character.'
      onSaved(saved)
    } catch (e) {
      failed = true
      status = `Saving failed: ${errText(e)}`
    } finally {
      saving = false
    }
  }

  async function revert() {
    if (dirty && !(await ask('Discard your changes and reload the saved parts?', { title: 'Revert parts', kind: 'warning' }))) return
    try {
      load(await api.avatarLoad(base.id))
      failed = false
      status = 'Reloaded the saved parts.'
    } catch (e) {
      failed = true
      status = `Reloading failed: ${errText(e)}`
    }
  }

  async function requestClose() {
    if (
      dirty &&
      !(await ask('Close the part editor and discard your unsaved changes?', {
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
        // The decoded size is authoritative (the stored one can differ for older imports of rotated photos).
        W = bmp.width
        H = bmp.height
        const s = Math.min(1, WORK / Math.max(W, H))
        ww = Math.max(1, Math.round(W * s))
        wh = Math.max(1, Math.round(H * s))
        const c = document.createElement('canvas')
        c.width = ww
        c.height = wh
        const cx = c.getContext('2d', { willReadFrequently: true })!
        cx.drawImage(bmp, 0, 0, ww, wh)
        rgba = cx.getImageData(0, 0, ww, wh).data
        load(fresh)
        loaded = true
        fitView()
        smart.setImage(bmp, `${fresh.id}:${W}x${H}`, W, H, ww, wh)
        if (picking) void smart.start() // picked while the image was loading
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
      fillLoad++ // a stored fill still loading is freed, not shown
      ro.disconnect()
      canvas.removeEventListener('wheel', wheel)
      cancelAnimationFrame(raf)
      cancelAnimationFrame(playRaf)
      smart.release() // every way out of the editor frees the model
      bitmap?.close()
      prev?.focus()
    }
  })

  const cursor = $derived(panning ? 'grabbing' : spaceDown || preview !== 'off' ? 'grab' : 'crosshair')
  const parentChoices = $derived(sel ? parts.filter((p) => p.id !== sel.id && !wouldLoop(parts, sel.id, p.id)) : [])
  const pct = (v: number) => `${Math.round(v * 100)}%`
</script>

<div class="scrim parts-scrim">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (keyboard shortcuts for the whole editor) -->
  <div
    class="dialog parts-ed"
    role="dialog"
    aria-modal="true"
    aria-labelledby="parts-title"
    tabindex="-1"
    onkeydown={onKey}
    onkeyup={(e) => e.key === ' ' && (spaceDown = false)}
  >
    <div class="dlg-head">
      <span class="ico acc"><Icon name="figure" /></span>
      <h2 id="parts-title">Edit parts: {base.name}</h2>
      <span class="badge" title="Derived from the parts: a character with arm or leg parts is a full-body figure, otherwise a portrait"
        >{kind === 'fullbody' ? 'Full body' : 'Portrait'}</span
      >
      <button type="button" class="icon-only ghost" title="Close the editor (Esc); asks before discarding unsaved changes" aria-label="Close" onclick={requestClose}
        ><Icon name="x" /></button
      >
    </div>

    <div class="bar fit" use:fit role="toolbar" aria-label="Part tools">
      <Btn
        icon="undo"
        label="Undo"
        title={picking && smart.prompts.length ? 'Remove the last smart select point (Ctrl+Z)' : 'Undo (Ctrl+Z)'}
        disabled={!history.undoStack.length && !(picking && smart.prompts.length)}
        onclick={undoAny}
      />
      <Btn icon="redo" label="Redo" title="Redo (Ctrl+Y or Ctrl+Shift+Z)" disabled={!history.redoStack.length} onclick={redo} />
      <Btn
        icon="trash"
        label={sub === 'interior' ? 'Clear open shape' : sub ? 'Clear lip' : 'Clear outline'}
        short="Clear"
        title={sub ? `Remove the outline of ${SUB[sub].what} to draw it again (can be undone)` : 'Remove the outline of the selected part to draw it again (can be undone)'}
        disabled={!editPts.length || preview !== 'off'}
        onclick={clearOutline}
      />
      <span class="spacer"></span>
      <button type="button" class="icon-only ghost" title="Zoom out (-)" aria-label="Zoom out" onclick={() => zoomAt(0.8)}><Icon name="zoom-out" /></button>
      <button type="button" class="icon-only ghost" title="Zoom in (+)" aria-label="Zoom in" onclick={() => zoomAt(1.25)}><Icon name="zoom-in" /></button>
      <button type="button" class="icon-only ghost" title="Fit the image into the view (0)" aria-label="Fit to view" onclick={fitView}><Icon name="maximize" /></button>
      <span class="select-wrap prev">
        <select bind:value={preview} aria-label="Preview" title="Preview the animated character against a background (editing is paused while it is on)">
          <option value="off">Edit</option>
          <option value="checker">Preview: checkerboard</option>
          <option value="green">Preview: green</option>
          <option value="dark">Preview: dark</option>
        </select><Icon name="chev-down" />
      </span>
    </div>

    <p id="parts-hint" class="help hint" title={hint}>{hint}</p>
    <div class="body">
      <aside class="side" aria-label="Parts and preview">
        <div class="add">
          <span class="select-wrap">
            <select
              bind:value={newRole}
              aria-label="Role of the new part"
              title="What the new part is. Left and right are the character's own sides (a figure facing you has its left eye on the right of the image). Each role can be used once, Custom any number of times."
            >
              {#each free as r (r.role)}<option value={r.role}>{r.label}</option>{/each}
            </select><Icon name="chev-down" />
          </span>
          <button
            type="button"
            class="sm"
            title={parts.length >= MAX_PARTS ? `At most ${MAX_PARTS} parts` : 'Add a part with this role, then click points around it on the image'}
            disabled={!loaded || parts.length >= MAX_PARTS || !!picking}
            onclick={addPart}><Icon name="plus" />Add</button
          >
          <button
            type="button"
            class="sm"
            aria-pressed={!!picking}
            title={parts.length >= MAX_PARTS
              ? `At most ${MAX_PARTS} parts`
              : 'Pick with Smart select: click the part on the image and an on-device model proposes its outline'}
            disabled={!loaded || (!picking && parts.length >= MAX_PARTS)}
            onclick={() => (picking ? stopPick() : startPick())}><Icon name="target" />Pick</button
          >
          <button
            type="button"
            class="sm"
            aria-pressed={faceOpen}
            title="Detect face: find both eyes and the mouth with its lips automatically (for photos and realistic paintings)"
            disabled={!loaded}
            onclick={() => ((faceOpen = !faceOpen), (faceNote = null))}><Icon name="user" />Face</button
          >
        </div>
        {#if faceOpen && !picking}
          <div class="picker" role="group" aria-label="Detect face">
            <FacePanel image={() => ({ bitmap, W, H })} disabled={parts.length >= MAX_PARTS} onResult={applyFace} />
            {#if faceNote}
              <span class="help">{faceNote.text}</span>
              {#if faceNote.at === history.undoStack.length}
                <button type="button" class="sm" title="Remove the detected parts again (Ctrl+Z)" onclick={() => ((faceNote = null), undo())}><Icon name="undo" />Undo</button>
              {/if}
            {/if}
          </div>
        {/if}
        {#if picking}
          <div class="picker" role="group" aria-label="Pick with Smart select">
            <span class="help">Picking: {roleInfo(picking).label}</span>
            <SmartSelectBar s={smart} acceptLabel="Create" acceptTitle={`Create the ${roleInfo(picking).label.toLowerCase()} from the proposal (Enter)`} onAccept={acceptPick} />
            <button type="button" class="sm" title="Stop picking (Esc)" onclick={stopPick}>Cancel</button>
          </div>
        {:else if offerSplit && parts.some((p) => p.role === 'mouth' && p.closed) && !hasLips}
          <div class="picker" role="group" aria-label="Lips">
            <span class="help">Mouth created. Derive both lips from its outline?</span>
            <button type="button" class="sm primary" title="Split the mouth outline into upper and lower lip (can be undone)" onclick={() => ((offerSplit = false), splitLips())}
              ><Icon name="scissors" />Auto-split lips</button
            >
            <button type="button" class="sm" onclick={() => (offerSplit = false)}>Not now</button>
          </div>
        {/if}
        <div class="plist" role="group" aria-label="Parts; later ones are drawn in front">
          {#each parts as p (p.id)}
            <div class="prow">
              <button
                type="button"
                class="pick ghost sm"
                aria-pressed={p.id === selId}
                title={`Select ${nameOf(p)} (${roleInfo(p.role).label}) to edit its outline and settings`}
                onclick={() => select(p.id)}
                ><span class="sw" style:background={roleInfo(p.role).colour}></span><span class="pn">{nameOf(p)}</span>{#if !p.closed}<span class="tag">open</span
                  >{/if}</button
              >
              <button
                type="button"
                class="icon-only ghost sm"
                aria-pressed={!hidden.has(p.id)}
                aria-label={`Show the outline of ${nameOf(p)}`}
                title={hidden.has(p.id) ? `Show the outline of ${nameOf(p)} on the image` : `Hide the outline of ${nameOf(p)} on the image (the part stays)`}
                onclick={() => toggleHidden(p.id)}><Icon name={hidden.has(p.id) ? 'eye-off' : 'eye'} /></button
              >
            </div>
          {:else}
            <p class="help empty">No parts yet.</p>
          {/each}
        </div>

        {#if sel}
          <div class="props">
            <label class="field">
              <span class="label">Label</span>
              <input
                type="text"
                value={sel.label}
                placeholder={roleInfo(sel.role).label}
                maxlength="80"
                title="Name shown in the list; empty uses the role name"
                onchange={(e) => setField(sel.id, 'label', e.currentTarget.value.trim())}
                onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            </label>
            <label class="field">
              <span class="label">Attached to</span>
              <span class="select-wrap">
                <select
                  value={sel.parent}
                  title="Parent part: this part moves along with it (a hand with its arm). Parts that would form a loop are not offered."
                  onchange={(e) => setField(sel.id, 'parent', e.currentTarget.value)}
                >
                  <option value="">Nothing</option>
                  {#each parentChoices as q (q.id)}<option value={q.id}>{nameOf(q)}</option>{/each}
                </select><Icon name="chev-down" />
              </span>
            </label>
            <div class="row tools">
              <button
                type="button"
                class="icon-only sm"
                title="Move up the list: drawn further back, behind the parts below it"
                aria-label="Move up (further back)"
                disabled={parts[0]?.id === sel.id}
                onclick={() => movePart(sel.id, -1)}><Icon name="arrow-up" /></button
              >
              <button
                type="button"
                class="icon-only sm"
                title="Move down the list: drawn further in front, over the parts above it"
                aria-label="Move down (further in front)"
                disabled={parts.at(-1)?.id === sel.id}
                onclick={() => movePart(sel.id, 1)}><Icon name="arrow-down" /></button
              >
              <button
                type="button"
                class="icon-only sm"
                title="Put the pivot back to its default place for this role"
                aria-label="Reset pivot"
                disabled={!sel.closed}
                onclick={() => resetPivot(sel.id)}><Icon name="target" /></button
              >
              <span class="spacer"></span>
              <button
                type="button"
                class="icon-only sm danger"
                title={`Delete ${nameOf(sel)} (can be undone)`}
                aria-label={`Delete ${nameOf(sel)}`}
                onclick={() => deletePart(sel.id)}><Icon name="trash" /></button
              >
            </div>
            {#if isEye(sel.role)}
              <div class="row">
                <label class="colour" title="Eyelid colour drawn while the eye blinks (usually the skin around the eye)">
                  <input
                    type="color"
                    value={sel.lid || DEFAULT_LID}
                    oninput={(e) => {
                      begin()
                      update(sel.id, (p) => ({ ...p, lid: e.currentTarget.value }))
                    }}
                    onchange={end}
                  /><span class="label">Eyelid</span>
                </label>
                <button
                  type="button"
                  class="sm"
                  title="Take the eyelid colour from the image around the eye outline"
                  disabled={!sel.closed}
                  onclick={() => setField(sel.id, 'lid', sample(sel))}>Sample</button
                >
              </div>
            {:else if sel.role === 'mouth'}
              <div class="row">
                <button
                  type="button"
                  class="sm"
                  aria-pressed={sub === 'interior'}
                  disabled={!sel.closed || hasLips}
                  title={hasLips
                    ? 'Not used while both lips are outlined: the opening between the lips is filled with the inside colour'
                    : 'Optional: outline the dark inside of the open mouth within the mouth part; while speaking it opens with the loudness. Without it the mouth opens as a dark shrunk copy of its outline.'}
                  onclick={() => editSub('interior')}><Icon name="polygon" />Open shape</button
                >
                <label class="colour" title="Colour of the open mouth">
                  <input
                    type="color"
                    value={mouthColor}
                    oninput={(e) => {
                      begin()
                      mouthColor = e.currentTarget.value
                    }}
                    onchange={end}
                  /><span class="label">Inside</span>
                </label>
              </div>
              <div class="row wrap" role="group" aria-label="Lips">
                <button
                  type="button"
                  class="sm"
                  aria-pressed={sub === 'lipUpper'}
                  disabled={!sel.closed}
                  title="Optional: outline the upper lip. With both lips the mouth opens by moving them apart (upper lip up, lower lip down) and the face around it follows."
                  onclick={() => editSub('lipUpper')}><Icon name="polygon" />Upper lip</button
                >
                <button
                  type="button"
                  class="sm"
                  aria-pressed={sub === 'lipLower'}
                  disabled={!sel.closed}
                  title="Optional: outline the lower lip (it moves down as the mouth opens; the chin follows)"
                  onclick={() => editSub('lipLower')}><Icon name="polygon" />Lower lip</button
                >
                <button
                  type="button"
                  class="sm"
                  disabled={!sel.closed}
                  title="Suggest both lips from the mouth outline: split it along the line between its left and right corner (replaces drawn lips; can be undone)"
                  onclick={splitLips}><Icon name="scissors" />Auto-split</button
                >
              </div>
            {/if}
          </div>
        {/if}

        <div class="fillsec" role="group" aria-label="Background under moved parts">
          <label
            class="opt"
            title="What shows where an arm, hand or leg was once it moves. Makes arms that cross the body look right: the copy of the arm left in the picture is cut out or painted over."
          >
            <span class="label">Under moved parts</span>
            <span class="select-wrap">
              <select value={fill.mode} onchange={(e) => setFillMode(e.currentTarget.value as FillMode)}>
                <option value="none">Original picture</option>
                <option value="transparent">Transparent</option>
                <option value="classic">Fill (classic)</option>
                <option value="ai">Fill (AI)</option>
              </select><Icon name="chev-down" />
            </span>
          </label>
          {#if fill.mode !== 'none'}
            <p class="help">
              {#if !fillPolys.length}Needs arm, hand or leg parts.
              {:else if fill.mode === 'transparent'}The area arms, hands and legs leave behind is cut out (window background or green screen shows).
              {:else if fill.mode === 'classic'}That area is filled smoothly from its surroundings; good for plain backgrounds and clothing.
              {:else}An AI model paints that area (patterns, stripes, backgrounds); the result is saved with the character.{/if}
              Use Play demo or the arm sliders to check it.
            </p>
          {/if}
          {#if fill.mode === 'ai'}
            <AiFillPanel image={() => ({ bitmap, W, H })} polys={fillPolys} state={aiState} onResult={aiResult} />
          {/if}
        </div>

        <div class="pose">
          <div class="row">
            <span class="label">Preview</span>
            <span class="spacer"></span>
            <button type="button" class="sm" aria-pressed={playing} title={playing ? 'Stop the demo animation' : 'Animate mouth, blink and limbs in the preview'} onclick={togglePlay}
              ><Icon name={playing ? 'stop' : 'play'} />{playing ? 'Stop' : 'Play demo'}</button
            >
            <button type="button" class="icon-only sm ghost" title="Reset the preview pose" aria-label="Reset pose" onclick={resetPose}><Icon name="refresh" /></button>
          </div>
          <label class="opt" title="How far the mouth is open (in the avatar window this follows the loudness of the speech)">
            <span class="label">Mouth open</span>
            <span class="range"><input type="range" min="0" max="1" step="0.01" value={pose.mouth} oninput={(e) => setPose('mouth', +e.currentTarget.value)} /><output>{pct(pose.mouth)}</output></span>
          </label>
          <label class="opt" title="Mouth shape (viseme); in the avatar window it follows the sound of the speech">
            <span class="label">Viseme</span>
            <span class="select-wrap">
              <select value={viseme} onchange={(e) => setViseme(e.currentTarget.value as Viseme)}>
                {#each Object.entries(VISEMES) as [k, v] (k)}<option value={k}>{v.label}</option>{/each}
              </select><Icon name="chev-down" />
            </span>
          </label>
          {#if parts.some((p) => p.role === 'mouth')}
            <label
              class="opt"
              title={hasLips
                ? 'How much cheeks and chin follow the lips (saved with the character); 0 moves only the lips'
                : 'Needs both lips: outline them or use Auto-split on the mouth'}
            >
              <span class="label">Face warp</span>
              <span class="range"
                ><input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={warp}
                  disabled={!hasLips}
                  oninput={(e) => {
                    begin()
                    warp = +e.currentTarget.value
                    if (preview === 'off') preview = 'checker'
                  }}
                  onchange={end}
                /><output>{pct(warp)}</output></span
              >
            </label>
          {/if}
          <label class="opt" title="How far the eyes are closed">
            <span class="label">Blink</span>
            <span class="range"><input type="range" min="0" max="1" step="0.01" value={pose.blink} oninput={(e) => setPose('blink', +e.currentTarget.value)} /><output>{pct(pose.blink)}</output></span>
          </label>
          {#each limbs as r (r)}
            <label class="opt" title={`Turn the ${POSE_LABEL[r].toLowerCase()} about its pivot (degrees; positive is clockwise)`}>
              <span class="label">{POSE_LABEL[r]}</span>
              <span class="range"
                ><input type="range" min="-60" max="60" step="1" value={pose[r]} oninput={(e) => setPose(r, +e.currentTarget.value)} /><output>{Math.round(pose[r])}°</output></span
              >
            </label>
          {/each}
        </div>
      </aside>

      <div class="stage" bind:this={wrap}>
        <canvas
          bind:this={canvas}
          tabindex="0"
          aria-label="Part canvas"
          aria-describedby="parts-hint parts-keys"
          style:cursor
          onpointerdown={down}
          onpointermove={move}
          onpointerup={up}
          onpointercancel={up}
          onpointerleave={() => {
            hover = null
            draw()
          }}
          oncontextmenu={(e) => e.preventDefault()}
        ></canvas>
        {#if !loaded}<div class="stage-msg">{failed ? status : 'Loading image…'}</div>{/if}
      </div>
    </div>
    <p id="parts-keys" class="vh">
      Keyboard: Enter closes the outline, Backspace removes the last point while drawing, Delete removes the selected
      point, arrow keys move the selected point (with Shift by 10 pixels) or pan, plus and minus zoom, 0 fits the image,
      hold Space and drag to pan, Ctrl+Z undo, Ctrl+Y redo, Ctrl+S save, Escape closes. While picking with Smart select,
      Enter creates the part, Backspace removes the last point and Escape clears the points or stops picking.
    </p>

    <div class="dlg-foot">
      <span class="msg" role="status">
        {#if failed || (status && !dirty)}<span class={failed ? 'err-text' : 'ok-text'}>{status}</span>
        {:else if warning}<span class="warn" title={warning}><Icon name="alert" />{warning}</span>{/if}
      </span>
      <button type="button" title="Discard changes and reload the saved parts" disabled={!dirty} onclick={revert}><Icon name="refresh" />Revert</button>
      <button type="button" title="Close the editor (Esc)" onclick={requestClose}>Close</button>
      <button
        type="button"
        class="primary"
        title={dirty ? 'Save the parts (Ctrl+S); the avatar window reloads the character' : 'Nothing to save'}
        disabled={!dirty || saving}
        onclick={save}><Icon name="check" />{saving ? 'Saving…' : 'Save'}</button
      >
    </div>
  </div>
</div>

<style>
  .parts-scrim {
    padding: 12px;
  }
  .parts-ed {
    width: 100%;
    height: 100%;
    max-width: 1600px;
  }
  .parts-ed .dlg-head {
    padding: 10px 12px 6px 16px;
  }
  .bar {
    margin: 0 13px;
  }
  .prev {
    flex: 0 1 128px;
    min-width: 84px; /* shrinks before the buttons collapse; 'Edit' still fits */
  }
  .hint {
    padding: 4px 16px 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 10px;
    margin: 0 16px;
  }
  .side {
    width: 224px;
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    padding: 2px 8px 2px 2px; /* room for the scrollbar */
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .add .select-wrap {
    flex: 1 1 100%;
  }
  .add > button {
    flex: 1;
  }
  .fillsec {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .picker {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--r);
    background: var(--surface-2);
  }
  .plist {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: 1px solid var(--border);
    border-radius: var(--r);
    padding: 3px;
  }
  .prow {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .pick {
    flex: 1;
    min-width: 0;
    justify-content: flex-start;
  }
  .pick[aria-pressed='true'] {
    background: var(--acc-soft);
    color: var(--acc-text);
  }
  .pn {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sw {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    flex: none;
  }
  .tag {
    margin-left: auto;
    font-size: var(--fs-xs);
    color: var(--busy);
  }
  .empty {
    padding: 6px 8px;
  }
  .props,
  .pose {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .tools {
    gap: 6px;
  }
  .wrap {
    flex-wrap: wrap;
    gap: 6px;
  }
  .colour {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .colour input {
    width: 32px;
    height: var(--h-sm);
    padding: 2px;
    flex: none;
  }
  .opt {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .stage {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 140px;
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
  .parts-ed .dlg-foot {
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
  @media (max-width: 640px) {
    .side {
      width: 180px;
    }
  }
</style>

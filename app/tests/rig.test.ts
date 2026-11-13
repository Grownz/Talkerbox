import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveKind, inImage, maskOutline, normalizePoint, validateRig, validId, wouldLoop, type Point, type Rig, type RigPart } from '../src/lib/rig.ts'

const part = (id: string, role: RigPart['role'], parent?: string): RigPart => ({
  id,
  role,
  polygon: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]],
  pivot: [0.15, 0.15],
  z: 0,
  parent,
})

const rig = (over: Partial<Rig> = {}): Rig => ({
  version: 1,
  id: 'anna',
  name: 'Anna',
  kind: 'portrait',
  image: { file: 'image.png', width: 640, height: 480 },
  mask: { points: [] },
  parts: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

test('kind is full body only with arms or legs', () => {
  assert.equal(deriveKind([part('e', 'eyeL'), part('m', 'mouth'), part('h', 'handL')]), 'portrait')
  assert.equal(deriveKind([part('a', 'armR')]), 'fullbody')
  assert.equal(deriveKind([part('l', 'legL')]), 'fullbody')
  assert.equal(deriveKind([]), 'portrait')
})

test('points are normalised and clamped', () => {
  assert.deepEqual(normalizePoint(320, 120, 640, 480), [0.5, 0.25])
  assert.deepEqual(normalizePoint(-5, 900, 640, 480), [0, 1])
  assert.deepEqual(normalizePoint(NaN, 10, 640, 0), [0, 1])
})

test('ids match the Rust sanitiser', () => {
  for (const ok of ['anna', 'anna-2', 'x', 'a'.repeat(64)]) assert.ok(validId(ok), ok)
  for (const bad of ['', '..', '../x', 'a/b', 'Anna', 'a.b', '-a', 'a-', 'a'.repeat(65)]) assert.ok(!validId(bad), bad)
})

test('valid rigs pass', () => {
  assert.equal(validateRig(rig()), null)
  assert.equal(validateRig(rig({ parts: [part('body', 'body'), part('head', 'head', 'body')] })), null)
  assert.equal(validateRig(rig({ mask: { points: [[0, 0], [1, 0], [0.5, 1]] } })), null)
  assert.equal(validateRig(rig({ parts: [part('a', 'custom'), part('b', 'custom')] })), null)
  assert.equal(validateRig(rig({ parts: [{ ...part('e', 'eyeL'), label: 'Left eye', lid: '#A1b2c3' }] })), null)
  assert.equal(validateRig(rig({ mouth: { states: [], interior: [[0.4, 0.6], [0.6, 0.6], [0.5, 0.7]], color: '#301010' } })), null)
  const up: Point[] = [[0.4, 0.6], [0.6, 0.6], [0.5, 0.58]]
  const low: Point[] = [[0.4, 0.6], [0.6, 0.6], [0.5, 0.63]]
  assert.equal(validateRig(rig({ mouth: { states: [], lipUpper: up, lipLower: low, corners: [[0.4, 0.6], [0.6, 0.6]], warp: 0 } })), null)
  assert.equal(validateRig(rig({ mouth: { states: [], lipUpper: up, lipLower: low, warp: 1 } })), null)
})

test('lip definitions are checked', () => {
  const up: Point[] = [[0.4, 0.6], [0.6, 0.6], [0.5, 0.58]]
  const bad: Rig['mouth'][] = [
    { states: [], lipUpper: up },
    { states: [], lipLower: up },
    { states: [], lipUpper: up, lipLower: [[0.4, 0.6], [0.6, 0.6]] },
    { states: [], lipUpper: up, lipLower: [[0.4, 0.6], [0.6, 0.6], [0.5, 1.1]] },
    { states: [], lipUpper: up, lipLower: Array.from({ length: 1025 }, (): Point => [0.5, 0.5]) },
    { states: [], lipUpper: up, lipLower: up, corners: [[0.4, 0.6]] as unknown as [Point, Point] },
    { states: [], lipUpper: up, lipLower: up, corners: [[0.4, 0.6], [Infinity, 0.6]] },
    { states: [], warp: 1.5 },
    { states: [], warp: -0.1 },
    { states: [], warp: Number.NaN },
  ]
  for (const m of bad) assert.notEqual(validateRig(rig({ mouth: m })), null, JSON.stringify(m))
})

test('parent choices that would loop are detected', () => {
  const parts = [part('arm', 'armL'), part('hand', 'handL', 'arm'), part('leg', 'legL')]
  assert.equal(wouldLoop(parts, 'hand', 'arm'), false)
  assert.equal(wouldLoop(parts, 'arm', 'hand'), true)
  assert.equal(wouldLoop(parts, 'arm', 'arm'), true)
  assert.equal(wouldLoop(parts, 'leg', 'hand'), false)
  assert.equal(wouldLoop([part('a', 'head', 'b'), part('b', 'body', 'a'), part('c', 'custom')], 'c', 'a'), true)
})

test('points must lie inside the image', () => {
  assert.ok(inImage([[0, 0], [1, 1], [0.5, 0.2]]))
  assert.ok(!inImage([[0, 0], [1.01, 1]]))
  assert.ok(!inImage([[0, -0.01]]))
  assert.ok(!inImage([[Infinity, 0]]))
})

test('invalid rigs are rejected', () => {
  const bad: Partial<Rig>[] = [
    { version: 2 },
    { id: '../x' },
    { name: ' ' },
    { name: 'a\nb' },
    { image: { file: '../../x.png', width: 1, height: 1 } },
    { image: { file: 'image.png', width: 0, height: 1 } },
    { image: { file: 'image.png', width: 9000, height: 1 } },
    { mask: { points: [[0, 0], [1, 1]] } },
    { mask: { points: [[0, 0], [1, 1], [2, 0]] } },
    { mask: { points: [[0, 0], [1, 1], [NaN, 0]] } },
    { mask: { points: [], smooth: 2 } },
    { mask: { points: [], snap: -0.1 } },
    { parts: [part('a', 'eyeL'), part('a', 'eyeR')] },
    { parts: [part('a', 'eyeL', 'missing')] },
    { parts: [part('a', 'head', 'b'), part('b', 'body', 'a')] },
    { parts: [{ ...part('a', 'head'), z: 1.5 }] },
    { parts: Array.from({ length: 65 }, (_, i) => part(`p${i}`, 'custom')) },
    { mouth: { states: [{ id: 'open', polygon: [[0, 0]] }] } },
    { parts: [part('a', 'armL'), part('b', 'armL')] },
    { parts: [{ ...part('e', 'eyeL'), label: ' ' }] },
    { parts: [{ ...part('e', 'eyeL'), label: 'x'.repeat(81) }] },
    { parts: [{ ...part('e', 'eyeL'), lid: 'red' }] },
    { mouth: { states: [], interior: [[0, 0], [1, 1]] } },
    { mouth: { states: [], interior: [[0, 0], [1, 1], [0, 1.5]] } },
    { mouth: { states: [], color: '#fff' } },
  ]
  for (const b of bad) assert.notEqual(validateRig(rig(b)), null, JSON.stringify(b))
})

test('mask outline prefers the baked smoothed points', () => {
  const tri: Point[] = [[0, 0], [1, 0], [0.5, 1]]
  const sm: Point[] = [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]]
  assert.equal(maskOutline(rig()), null)
  assert.deepEqual(maskOutline(rig({ mask: { points: tri } })), tri)
  assert.deepEqual(maskOutline(rig({ mask: { points: tri, smoothed: sm, smooth: 0.5 } })), sm)
  assert.deepEqual(maskOutline(rig({ mask: { points: tri, smoothed: [] } })), tri)
  assert.equal(validateRig(rig({ mask: { points: tri, smoothed: sm, smooth: 0.5, snap: 1 } })), null)
})

test('background fill under moved parts is checked like in Rust', () => {
  const ai = { mode: 'ai' as const, image: 'fill.png' as const, rect: [0.1, 0.2, 0.5, 0.9] as [number, number, number, number], sig: '0a1b2c3d' }
  assert.equal(validateRig(rig({ fill: { mode: 'transparent' } })), null)
  assert.equal(validateRig(rig({ fill: { mode: 'ai' } })), null, 'AI without a result yet: the classic fill is shown')
  assert.equal(validateRig(rig({ fill: ai })), null)
  for (const bad of [
    { mode: 'blur' },
    { ...ai, image: '../x.png' },
    { ...ai, rect: undefined },
    { ...ai, image: undefined },
    { ...ai, rect: [0.5, 0.2, 0.1, 0.9] },
    { ...ai, rect: [0, 0, 1, Number.NaN] },
    { ...ai, sig: 'not hex!' },
  ])
    assert.notEqual(validateRig(rig({ fill: bad as Rig['fill'] })), null, JSON.stringify(bad))
})

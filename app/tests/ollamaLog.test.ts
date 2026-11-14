import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PRESETS, classify, filterLines, parseLine, segments, topicsOn, viewRows, type Group, type Hidden, type Topic } from '../src/lib/ollamaLog.ts'

const LISTEN = 'time=2025-08-11T15:22:24.123+02:00 level=INFO source=routes.go:1288 msg="Listening on 127.0.0.1:11434 (version 0.9.6)"'
const ROCM = 'level=WARN source=amd_windows.go:56 msg="unable to verify rocm library: no suitable rocm found, falling back to CPU"'
const GIN200 = '[GIN] 2025/08/11 - 15:22:24 | 200 | 18.5863319s | 127.0.0.1 | POST "/api/chat"'

test('slog line: level, short time with full tooltip value, time key removed, rest in order', () => {
  assert.deepEqual(parseLine(LISTEN), {
    level: 'info',
    time: '15:22:24.123',
    timeFull: '2025-08-11T15:22:24.123+02:00',
    text: 'level=INFO source=routes.go:1288 msg="Listening on 127.0.0.1:11434 (version 0.9.6)"',
  })
})

test('slog line without time keeps its text', () => {
  assert.deepEqual(parseLine(ROCM), { level: 'warn', time: '', timeFull: '', text: ROCM })
})

test('slog levels with offsets, ERROR and DEBUG', () => {
  assert.equal(parseLine('time=2025-08-11T15:22:24+02:00 level=ERROR msg=x').level, 'error')
  assert.equal(parseLine('time=2025-08-11T15:22:24+02:00 level=ERROR msg=x').time, '15:22:24')
  assert.equal(parseLine('level=DEBUG source=a.go:1 msg=y').level, 'debug')
  assert.equal(parseLine('level=DEBUG-4 msg=y').level, 'debug')
  assert.equal(parseLine('level=WARN+2 msg=y').level, 'warn')
  assert.equal(parseLine('level=NOTICE msg=y').level, null) // unknown level degrades to neutral
})

test('GIN lines keep their text; only 4xx/5xx get a level', () => {
  assert.deepEqual(parseLine(GIN200), { level: null, time: '', timeFull: '', text: GIN200 })
  assert.equal(parseLine(GIN200.replace('| 200 |', '| 500 |')).level, 'error')
  assert.equal(parseLine(GIN200.replace('| 200 |', '| 404 |')).level, 'warn')
})

test('llama.cpp output, raw errors, empty and garbage lines pass through', () => {
  for (const raw of ['load_tensors: CPU model buffer size = 1834.82 MiB', 'cuInit err: 100', '', '   ', '=== ??? ===', 'time=', 'time=garbage level', '"unterminated=', '\u0000\u0001￿']) {
    assert.deepEqual(parseLine(raw), { level: null, time: '', timeFull: '', text: raw }, JSON.stringify(raw))
  }
})

test('level= inside a quoted msg value is not read as the level', () => {
  const raw = 'time=2025-08-11T15:22:24.123+02:00 source=x.go:1 msg="got level=ERROR from peer" level=INFO'
  assert.equal(parseLine(raw).level, null) // level comes after msg here: not in slog's leading position
  const quoted = 'time=2025-08-11T15:22:24.123+02:00 level=INFO msg="client said \\"level=ERROR\\" k.v=1"'
  assert.equal(parseLine(quoted).level, 'info')
  assert.equal(parseLine('msg="level=ERROR"').level, null)
})

test('keys with dots and unicode values', () => {
  const raw = 'time=2025-08-11T15:22:24.123+02:00 level=INFO gpu.name="Example GPU 0" msg="Grüße 模型 ✓"'
  const p = parseLine(raw)
  assert.equal(p.level, 'info')
  assert.equal(p.text, 'level=INFO gpu.name="Example GPU 0" msg="Grüße 模型 ✓"')
})

test('very long line is handled', () => {
  const raw = 'time=2025-08-11T15:22:24.123+02:00 level=ERROR msg="' + 'x'.repeat(200_000) + '"'
  const p = parseLine(raw)
  assert.equal(p.level, 'error')
  assert.equal(p.text.length, raw.length - 'time=2025-08-11T15:22:24.123+02:00 '.length)
  const plain = 'a'.repeat(200_000)
  assert.equal(parseLine(plain).text, plain)
})

test('never throws on odd input', () => {
  assert.doesNotThrow(() => parseLine(undefined as unknown as string))
  assert.equal(parseLine(null as unknown as string).level, null)
})

const lines = [LISTEN, ROCM, GIN200, 'cuInit err: 100', 'level=ERROR msg="boom"', 'level=DEBUG msg=dbg'].map((raw) => ({ raw, ...parseLine(raw) }))
const all: Record<Group, boolean> = { error: true, warn: true, info: true, other: true }

test('filter by level group: debug and unlevelled are "other"', () => {
  assert.equal(filterLines(lines, all, ''), lines) // nothing to filter: same array
  assert.deepEqual(filterLines(lines, { ...all, other: false }, '').map((l) => l.level), ['info', 'warn', 'error'])
  assert.deepEqual(filterLines(lines, { error: true, warn: false, info: false, other: false }, '').map((l) => l.raw), ['level=ERROR msg="boom"'])
})

test('search is a case-insensitive substring over the raw line and combines with levels', () => {
  assert.deepEqual(filterLines(lines, all, 'ROCM').map((l) => l.raw), [ROCM])
  assert.equal(filterLines(lines, all, '15:22:24').length, 2) // the timestamp is searchable although hidden
  assert.equal(filterLines(lines, { ...all, warn: false }, 'rocm').length, 0)
  assert.equal(filterLines(lines, all, 'nope').length, 0)
})

test('segments marks every match and keeps the text intact', () => {
  const s = segments('Foo bar foo', 'foo')
  assert.deepEqual(s, [{ t: 'Foo', hit: true }, { t: ' bar ', hit: false }, { t: 'foo', hit: true }])
  assert.deepEqual(segments('abc', ''), [{ t: 'abc', hit: false }])
  assert.deepEqual(segments('', 'x'), [{ t: '', hit: false }])
  assert.equal(segments('aaaa', 'aa').filter((x) => x.hit).length, 2)
  assert.deepEqual(segments('İx', 'x'), [{ t: 'İx', hit: false }]) // length-changing lowercase: no highlight
})

// ---- Topics ----

const T = 'time=2030-01-02T10:00:00.000+01:00 level=INFO source='
const gin = (status: number, method: string, path: string) => `[GIN] 2030/01/02 - 10:00:00 | ${status} |       0s |       127.0.0.1 | ${method.padEnd(8)} "${path}"`
const topicCases: [string, Topic][] = [
  ['--- Talkerbox started C:\\Users\\USER\\ollama.exe serve ---', 'app'],
  ['Error: listen tcp 127.0.0.1:11434: bind: address already in use', 'config'],
  ['Error: mkdir C:\\Users\\USER\\x: The system cannot find the path specified.', 'config'],
  ['Error: listen tcp: lookup a::b: no such host', 'config'],
  ['panic: runtime error: index out of range', 'other'],
  ['fatal error: out of memory', 'other'],
  [T + 'routes.go:1 msg="server config" env="map[]"', 'config'],
  [T + 'routes.go:2 msg="vram-based default context" total_vram="8 GiB"', 'gpu'],
  [T + 'images.go:3 msg="total blobs: 0"', 'config'],
  [T + 'images.go:4 msg="template selection" model=example:1b', 'load'],
  [T + 'model_recommendations.go:5 msg="cache sleep scheduled"', 'config'],
  [T + 'runner.go:6 msg="discovering available GPUs..."', 'gpu'],
  ['time=2030-01-02T10:00:00.000+01:00 level=WARN source=amd.go:7 msg="AMD driver is too old."', 'gpu'],
  [T + 'types.go:8 msg="inference compute" library=cpu', 'gpu'],
  [T + 'sched.go:9 msg="gpu memory" id=0', 'gpu'],
  [T + 'sched.go:10 msg="system memory" total="8 GiB"', 'gpu'],
  [T + 'sched.go:11 msg="loaded runners" count=1', 'load'],
  ['time=2030-01-02T10:00:00.000+01:00 level=WARN source=server.go:12 msg="requested context size too large for model" num_ctx=99999', 'load'],
  [T + 'llama_server.go:13 msg="waiting for llama-server to become available" status="llm server error"', 'load'],
  [T + 'download.go:14 msg="downloading aaaaaaaaaaaa in 2 100 MB part(s)"', 'requests'],
  [T + 'whatever.go:15 msg="new"', 'other'],
  ['time=2030-01-02T10:00:00.000+01:00 level=INFO msg="no source"', 'other'],
  [gin(200, 'GET', '/api/version'), 'polling'],
  [gin(200, 'GET', '/api/tags'), 'polling'],
  [gin(200, 'GET', '/api/ps'), 'polling'],
  [gin(404, 'POST', '/api/show'), 'polling'],
  [gin(200, 'GET', '/api/version?x=1'), 'polling'],
  [gin(200, 'POST', '/api/chat'), 'requests'],
  [gin(200, 'POST', '/api/generate'), 'requests'],
  [gin(200, 'POST', '/api/pull'), 'requests'],
  [gin(200, 'POST', '/api/create'), 'requests'],
  [gin(200, 'POST', '/api/copy'), 'requests'],
  [gin(404, 'DELETE', '/api/delete'), 'requests'],
  [gin(404, 'HEAD', '/api/blobs/sha256:0000'), 'requests'],
  [gin(200, 'GET', '/api/something-new'), 'requests'],
  ['[GIN] garbled', 'requests'],
  ['llama_model_loader: - kv   0: general.architecture str = llama', 'details'],
  ['print_info: n_layer = 16', 'details'],
  ['load: special tokens cache size = 10', 'details'],
  ['ggml_cuda_init: found 1 CUDA devices:', 'gpu'],
  ['load_backend: loaded CPU backend from C:\\Users\\USER\\ggml-cpu.dll', 'gpu'],
  ['llama_prepare_model_devices: using device CUDA0 (Example GPU 0)', 'gpu'],
  ['common_params_fit_impl: getting device memory data', 'gpu'],
  ['common_fit_params: successfully fit params', 'gpu'],
  ['common_memory_breakdown_print: | memory breakdown [MiB] |', 'gpu'],
  ['cmn  common_param: device_info:', 'gpu'],
  ['load_tensors: offloaded 17/17 layers to GPU', 'load'],
  ['llama_context: n_ctx = 4096', 'load'],
  ['llama_kv_cache: size = 150.00 MiB', 'load'],
  ['llama_memory_recurrent: x', 'load'],
  ['sched_reserve: reserving ...', 'load'],
  ['resolve_fused_ops: Flash Attention enabled', 'load'],
  ['clip_model_loader: model name: x', 'load'],
  ['clip_ctx: CLIP using CUDA0 backend', 'load'],
  ['load_hparams: projector: x', 'load'],
  ['get_dummy_batch: x', 'load'],
  ['reserve_compute_meta: x', 'load'],
  ['warmup: warming up', 'load'],
  ['srv    load_model: loading model', 'load'],
  ['srv          init: using 8 threads', 'load'],
  ['srv  init_listene: The UI is disabled', 'load'],
  ['srv  server_setup: security: x', 'load'],
  ['srv  server_run_i: model loaded', 'load'],
  ['srv  server_on_li: listening on http://127.0.0.1:50001', 'load'],
  ['srv  llama_server: initializing ...', 'load'],
  ['cmn  common_fit_a: fitting params', 'load'],
  ['cmn  common_init_: added logit bias', 'load'],
  ['cmn  common_conte: x', 'load'],
  ['cmn          init: llama threadpool init', 'load'],
  ['spec common_specu: no implementations', 'load'],
  ['slot   load_model: id  0 | task -1 | new slot', 'load'],
  ['slot launch_slot_: id  0 | task 0 | processing task', 'gen'],
  ['slot   operator(): id  0 | task 0 | new prompt', 'gen'],
  ['slot get_availabl: id  0 | task -1 | selected slot', 'gen'],
  ['slot init_sampler: id  0 | task 0 | init sampler', 'gen'],
  ['slot create_check: id  0 | task 0 | x', 'gen'],
  ['slot print_timing: id  0 | task 0 | total time = 70 ms', 'gen'],
  ['slot      release: id  0 | task 0 | stop processing', 'gen'],
  ['srv  get_availabl: updating prompt cache', 'gen'],
  ['srv        update:  - cache state: 0 prompts', 'gen'],
  ['srv          load:  - looking for better prompt', 'gen'],
  ['srv   prompt_save:  - saving prompt', 'gen'],
  ['srv          stop: cancel task, id_task = 5', 'gen'],
  ['srv  update_slots: all slots are idle', 'gen'],
  ['srv  server_strea: conv_id= (empty=1)', 'gen'],
  ['srv  brand_new_fn: x', 'other'],
  ['cmn  brand_new_fn: x', 'other'],
  ['unknown_function: something new', 'other'],
]

test('topic rules, one per line shape (new records never inherit)', () => {
  for (const [raw, want] of topicCases) {
    assert.equal(classify(raw, null), want, raw)
    assert.equal(classify(raw, 'details'), want, raw + ' (after details)')
  }
})

test('message words never decide severity or topic', () => {
  assert.equal(parseLine(T + 'llama_server.go:1 msg="waiting" status="llm server error"').level, 'info')
  assert.equal(classify('time=x level=INFO source=whatever.go:1 msg="gpu memory error"', null), 'other')
})

test('startup Error: lines are errors; panic and fatal error too', () => {
  assert.equal(parseLine('Error: listen tcp: lookup a::b: no such host').level, 'error')
  assert.equal(parseLine('panic: boom').level, 'error')
  assert.equal(parseLine('fatal error: boom').level, 'error')
  assert.equal(parseLine('error: lowercase is not the Go startup failure').level, null)
})

function classifyAll(lines: string[]): Topic[] {
  let prev: Topic | null = null
  return lines.map((l) => (prev = classify(l, prev)))
}

test('continuation lines inherit: tab-indented sampler block', () => {
  const block = ['slot launch_slot_: id  0 | task -1 | sampler params: ', '\trepeat_last_n = 64, repeat_penalty = 1.000', '\ttop_k = 40, top_p = 0.900', 'slot launch_slot_: id  0 | task 0 | processing task']
  assert.deepEqual(classifyAll(block), ['gen', 'gen', 'gen', 'gen'])
  assert.equal(parseLine('\ttop_k = 40').level, null)
})

test('continuation lines inherit: chat-template example and device line', () => {
  const block = [
    "srv          init: init: chat template, example_format: '<|im_start|>system",
    'You are a helpful assistant<|im_end|>',
    '<|im_start|>user',
    'Hello<|im_end|>',
    '',
    "'",
    'srv          init: init: chat template, thinking = 0',
    'ggml_cuda_init: found 1 CUDA devices:',
    '  Device 0: Example GPU 0, compute capability 8.0',
  ]
  assert.deepEqual(classifyAll(block), ['load', 'load', 'load', 'load', 'load', 'load', 'load', 'gpu', 'gpu'])
})

test('a GIN line between runner lines keeps its own topic; a continuation right after it inherits the GIN topic', () => {
  // Accepted limitation: lines are classified in arrival order, so a continuation that follows an interleaved GIN line
  // joins the GIN line's topic, not the runner record it really continues.
  const block = ['slot launch_slot_: id  0 | task -1 | sampler params: ', gin(200, 'GET', '/api/ps'), '\ttop_k = 40', 'slot launch_slot_: id  0 | task 0 | processing task']
  assert.deepEqual(classifyAll(block), ['gen', 'polling', 'polling', 'gen'])
})

test('no previous line: continuation is other; garbage never throws; long lines stay cheap', () => {
  assert.equal(classify('\tindented', null), 'other')
  assert.equal(classify('', null), 'other')
  assert.equal(classify('', 'gen'), 'gen')
  for (const raw of ['', ' ', '=== ??? ===', 'time=', 'time=garbage level', '[GIN', '\u0000\u0001￿', 'x'.repeat(200_000), 'a:'.repeat(100_000)]) {
    assert.doesNotThrow(() => classify(raw, 'gen'), JSON.stringify(raw.slice(0, 20)))
  }
  assert.equal(classify(undefined as unknown as string, null), 'other')
  assert.equal(classify('time=garbage level', 'gen'), 'other') // time= but not slog: never inherited
  const long = T + 'a.go:1 msg="' + 'x'.repeat(200_000)
  const t0 = performance.now()
  for (let i = 0; i < 1000; i++) classify(long, null)
  assert.ok(performance.now() - t0 < 2000, 'long lines stay cheap')
})

// ---- Fixtures (synthetic, composed by hand; see tests/fixtures/ollama-log) ----

const FIX = new URL('./fixtures/ollama-log/', import.meta.url)
const fixtures = readdirSync(FIX).filter((f) => f.endsWith('.log'))
const read = (f: string) => readFileSync(new URL(f, FIX), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/)

test('fixtures contain no PC-local data', () => {
  assert.ok(fixtures.length >= 5)
  for (const f of fixtures) {
    const text = readFileSync(new URL(f, FIX), 'utf8')
    for (const m of text.matchAll(/C:\\{1,2}Users\\{1,2}([^\\\s'"]*)/gi)) assert.equal(m[1], 'USER', `${f}: user path ${m[0]}`)
    for (const bad of ['GeForce', 'RTX', 'Radeon', 'Ryzen', 'Intel(R)', 'NVIDIA GeForce', 'claude', 'scratchpad']) {
      assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), `${f}: contains ${bad}`)
    }
    for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) assert.equal(ip, '127.0.0.1', `${f}: ip ${ip}`)
  }
})

test('every fixture classifies; all topics occur; little is "other"', () => {
  const count: Partial<Record<Topic, number>> = {}
  for (const f of fixtures) for (const t of classifyAll(read(f))) count[t] = (count[t] ?? 0) + 1
  for (const t of ['app', 'gpu', 'load', 'details', 'gen', 'requests', 'polling', 'config'] as Topic[]) assert.ok((count[t] ?? 0) > 0, `no ${t} lines`)
  const gpu = classifyAll(read('gpu-run.log'))
  const other = gpu.filter((t) => t === 'other').length
  assert.ok(other / gpu.length < 0.05, `other ${other}/${gpu.length}`)
})

test('fixture startup failures are config errors', () => {
  for (const f of ['startup-port-in-use.log', 'startup-bad-host.log', 'startup-bad-models-dir.log']) {
    const lines = read(f)
    assert.equal(parseLine(lines[lines.length - 1]).level, 'error', f)
    assert.equal(classifyAll(lines).at(-1), 'config', f)
  }
})

test('fixture severities: CPU-only warnings, num_ctx WARN, GIN 400', () => {
  const cpu = read('cpu-only.log').map(parseLine)
  assert.equal(cpu.filter((l) => l.level === 'warn' && l.text.includes('user overrode visible devices')).length, 2)
  const gpu = read('gpu-run.log').map(parseLine)
  assert.ok(gpu.some((l) => l.level === 'warn' && l.text.includes('requested context size too large')))
  assert.ok(gpu.some((l) => l.level === 'warn' && l.text.includes('| 400 |')))
})

// ---- View: topic x severity x search, placeholders ----

const POLL = gin(200, 'GET', '/api/ps')
const viewSrc = [
  T + 'routes.go:1 msg="Listening on 127.0.0.1:11434"',
  POLL,
  POLL,
  'time=x level=DEBUG source=routes.go:1 msg="dbg"', // config; severity group "other"
  POLL,
  gin(404, 'POST', '/api/chat'),
  'print_info: n_layer = 16',
  'print_info: n_head = 8',
  POLL,
]
const viewTopics = classifyAll(viewSrc)
const view = viewSrc.map((raw, i) => ({ id: i + 1, raw, level: parseLine(raw).level, topic: viewTopics[i] }))
const sev: Record<Group, boolean> = { error: true, warn: true, info: true, other: true }
const desc = (rows: ReturnType<typeof viewRows<(typeof view)[number]>>['rows']) => rows.map((r) => ('key' in r ? `${(r as Hidden).hidden}x${r.topic}` : r.id))

test('topics, severity and search combine', () => {
  assert.equal(viewRows(view, sev, topicsOn(PRESETS.All), '').shown.length, view.length)
  assert.deepEqual(viewRows(view, sev, topicsOn(['requests']), '').shown.map((l) => l.id), [6])
  assert.deepEqual(viewRows(view, { ...sev, warn: false }, topicsOn(['requests', 'config']), '').shown.map((l) => l.id), [1, 4])
  assert.deepEqual(viewRows(view, sev, topicsOn(PRESETS.All), 'n_head').shown.map((l) => l.id), [8])
  assert.deepEqual(viewRows(view, { ...sev, other: false }, topicsOn(PRESETS.All), '').shown.map((l) => l.id), [1, 6])
})

test('contiguous runs hidden only by topic collapse into one placeholder each', () => {
  const rows = viewRows(view, sev, topicsOn(PRESETS.Overview), '').rows
  assert.deepEqual(desc(rows), [1, '2xpolling', 4, '1xpolling', 6, '2xdetails', '1xpolling'])
  const keys = rows.map((r) => ('key' in r ? r.key : r.id))
  assert.equal(new Set(keys).size, keys.length)
  // Lines hidden by severity get no placeholder (unlevelled polls and details fall in the "other" severity group).
  assert.deepEqual(desc(viewRows(view, { ...sev, other: false }, topicsOn(PRESETS.Overview), '').rows), [1, 6])
  // Search: only matching lines are counted; the non-matching DEBUG line between polls does not split the run.
  assert.deepEqual(desc(viewRows(view, sev, topicsOn(PRESETS.Overview), '/api/ps').rows), ['4xpolling'])
})

test('presets', () => {
  const on = (p: keyof typeof PRESETS) => Object.entries(topicsOn(PRESETS[p])).filter(([, v]) => v).map(([k]) => k).sort()
  assert.deepEqual(on('Overview'), ['app', 'config', 'gen', 'gpu', 'load', 'other', 'requests'])
  assert.deepEqual(on('Loading'), ['config', 'details', 'gpu', 'load', 'other'])
  assert.equal(on('All').length, 9)
})

// Parsing and filtering for the Ollama server output view. Pure and tolerant: never throws, unknown shapes pass
// through unchanged (level null, text = raw).

export type Level = 'error' | 'warn' | 'info' | 'debug' | null
/** Filter groups: debug and unlevelled lines share "other". */
export type Group = 'error' | 'warn' | 'info' | 'other'

export interface Parsed {
  level: Level
  /** HH:MM:SS.mmm from a leading slog `time=` value, or '' when the line has none. */
  time: string
  /** The original timestamp value (tooltip), or ''. */
  timeFull: string
  /** Line without the leading `time=...` token when it was shortened, otherwise the raw line. */
  text: string
}

export const LABEL: Record<Exclude<Level, null>, string> = { error: 'ERROR', warn: 'WARN', info: 'INFO', debug: 'DEBUG' }

// One slog key=value token; values may be quoted with backslash escapes (msg="a \"b\" c"). Sticky: tokens must be contiguous.
const TOKEN = /([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|[^\s"]*)(?:\s+|$)/y
const SHORT = /T(\d{2}:\d{2}:\d{2})(\.\d{1,3})?/
const GIN = /^\[GIN\][^|]*\|\s*(\d)\d\d\s*\|/

function slogLevel(v: string): Level {
  // slog prints offsets like WARN+2 or DEBUG-4 (Ollama's TRACE); go by the base name only.
  const b = v.replace(/^"|"$/g, '').toUpperCase()
  return b.startsWith('ERR') ? 'error' : b.startsWith('WARN') ? 'warn' : b.startsWith('INFO') ? 'info' : b.startsWith('DEBUG') || b.startsWith('TRACE') ? 'debug' : null
}

export function parseLine(raw: string): Parsed {
  const out: Parsed = { level: null, time: '', timeFull: '', text: raw }
  if (typeof raw !== 'string') return { ...out, text: String(raw) }
  // Startup failures (port in use, bad models folder, bad OLLAMA_HOST) and Go crashes print a bare line and exit.
  if (/^(?:Error|panic|fatal error): /.test(raw)) return { ...out, level: 'error' }
  const gin = GIN.exec(raw)
  if (gin) {
    out.level = gin[1] === '5' ? 'error' : gin[1] === '4' ? 'warn' : null
    return out
  }
  // slog always starts with `time=... level=...`; reading only those two leading tokens keeps long lines cheap and
  // means a `level=` later in the line (or inside a quoted msg value) is never taken as the level.
  TOKEN.lastIndex = 0
  for (let i = 0; i < 2 && TOKEN.lastIndex < raw.length; i++) {
    const start = TOKEN.lastIndex
    const m = TOKEN.exec(raw)
    if (!m) break
    if (m[1] === 'time' && start === 0) {
      const s = SHORT.exec(m[2])
      if (s) Object.assign(out, { time: s[1] + (s[2] ?? ''), timeFull: m[2], text: raw.slice(TOKEN.lastIndex) })
    } else if (m[1] === 'level') {
      out.level = slogLevel(m[2])
      break
    }
  }
  return out
}

export function group(level: Level): Group {
  return level === 'error' || level === 'warn' || level === 'info' ? level : 'other'
}

/** Lines whose group is switched on and whose raw text contains `query` (case-insensitive; empty matches all). */
export function filterLines<T extends { raw: string; level: Level }>(lines: T[], on: Record<Group, boolean>, query: string): T[] {
  const q = query.toLowerCase()
  if (!q && on.error && on.warn && on.info && on.other) return lines
  return lines.filter((l) => on[group(l.level)] && (!q || l.raw.toLowerCase().includes(q)))
}

export type Topic = 'app' | 'config' | 'gpu' | 'load' | 'details' | 'gen' | 'requests' | 'polling' | 'other'

export const TOPICS: { t: Topic; label: string; title: string }[] = [
  { t: 'app', label: 'Talkerbox', title: 'Markers Talkerbox writes when it starts the server' },
  { t: 'config', label: 'Start & config', title: 'Server start-up, configuration and start-up errors' },
  { t: 'gpu', label: 'GPU & memory', title: 'GPU discovery, devices and memory planning' },
  { t: 'load', label: 'Model loading', title: 'Starting the runner and loading a model' },
  { t: 'details', label: 'Model details', title: 'Model metadata dumped while loading (long)' },
  { t: 'gen', label: 'Generation', title: 'Prompt processing, sampling and timings' },
  { t: 'requests', label: 'Requests', title: 'API requests: chat, generate, pull, create, copy, delete' },
  { t: 'polling', label: 'Status checks', title: 'Routine polls: version, tags, ps, show' },
  { t: 'other', label: 'Other', title: 'Lines no rule recognises' },
]

export const PRESETS: Record<'Overview' | 'Loading' | 'All', Topic[]> = {
  Overview: ['app', 'config', 'gpu', 'load', 'gen', 'requests', 'other'],
  Loading: ['config', 'gpu', 'load', 'details', 'other'],
  All: TOPICS.map((x) => x.t),
}

export function topicsOn(list: Topic[]): Record<Topic, boolean> {
  return Object.fromEntries(TOPICS.map(({ t }) => [t, list.includes(t)])) as Record<Topic, boolean>
}

// Only line starts are looked at (HEAD chars), so very long lines stay cheap.
const HEAD = 300
const SLOG = /^(?:time=\S*\s+)?level=\S*\s+(?:source=([\w.-]+?)\.go:\d+\s+)?(?:msg="?([^"]*))?/
const GIN_REQ = /^\[GIN\](?:[^|]*\|){4}\s*([A-Z]+)\s+"([^"?]*)/
const RUNNER = /^(srv|slot|cmn|spec)\s+([^\s:]+):/
const FUNC = /^([A-Za-z_][A-Za-z0-9_]*):/
const POLLS = new Set(['GET /api/version', 'GET /api/tags', 'GET /api/ps', 'POST /api/show'])
const SRC: Record<string, Topic> = {
  routes: 'config', images: 'config', model_recommendations: 'config',
  runner: 'gpu', amd: 'gpu', types: 'gpu',
  server: 'load', llama_server: 'load', download: 'requests',
}
const RUN: Record<string, Topic> = {
  // llama.cpp pads the subsystem and cuts the function name to 12 characters (init_listene, common_fit_a).
  'srv load_model': 'load', 'srv init': 'load', 'srv init_listene': 'load', 'srv server_setup': 'load', 'srv server_run_i': 'load',
  'srv server_on_li': 'load', 'srv llama_server': 'load', 'cmn common_fit_a': 'load', 'cmn common_init_': 'load', 'cmn common_conte': 'load',
  'cmn init': 'load', 'spec common_specu': 'load', 'slot load_model': 'load', 'cmn common_param': 'gpu',
  'srv get_availabl': 'gen', 'srv update': 'gen', 'srv load': 'gen', 'srv prompt_save': 'gen', 'srv stop': 'gen', 'srv update_slots': 'gen', 'srv server_strea': 'gen',
}
const FN: Record<string, Topic> = {
  llama_model_loader: 'details', print_info: 'details', load: 'details',
  ggml_cuda_init: 'gpu', load_backend: 'gpu', llama_prepare_model_devices: 'gpu', common_params_fit_impl: 'gpu', common_fit_params: 'gpu', common_memory_breakdown_print: 'gpu',
  load_tensors: 'load', llama_context: 'load', llama_kv_cache: 'load', llama_memory_recurrent: 'load', sched_reserve: 'load', resolve_fused_ops: 'load',
  clip_model_loader: 'load', clip_ctx: 'load', load_hparams: 'load', get_dummy_batch: 'load', reserve_compute_meta: 'load', warmup: 'load',
}

/**
 * Topic of one line; `prev` is the previous line's topic (null at the start or after Clear). Lines that do not start a
 * record (indented, blank, chat-template example text) continue the previous line's topic. Goes by source file and
 * line prefix; msg text only decides three fixed cases, never words like "error".
 */
export function classify(raw: string, prev: Topic | null): Topic {
  if (typeof raw !== 'string') return prev ?? 'other'
  const h = raw.slice(0, HEAD)
  if (h.startsWith('--- Talkerbox started')) return 'app'
  if (h.startsWith('Error: ')) return 'config'
  if (h.startsWith('panic: ') || h.startsWith('fatal error: ')) return 'other'
  if (h.startsWith('time=') || h.startsWith('level=')) {
    const m = SLOG.exec(h)
    const src = m?.[1] ?? ''
    const msg = m?.[2] ?? ''
    if (src === 'routes' && msg.startsWith('vram-based default context')) return 'gpu'
    if (src === 'images' && msg.startsWith('template selection')) return 'load'
    if (src === 'sched') return msg.includes('memory') ? 'gpu' : 'load'
    return SRC[src] ?? 'other'
  }
  if (h.startsWith('[GIN]')) {
    const m = GIN_REQ.exec(h)
    return m && POLLS.has(`${m[1]} ${m[2]}`) ? 'polling' : 'requests'
  }
  const r = RUNNER.exec(h)
  // Every slot line belongs to a generation slot, except the one created while the model loads.
  if (r) return RUN[`${r[1]} ${r[2]}`] ?? (r[1] === 'slot' ? 'gen' : 'other')
  const f = FUNC.exec(h)
  if (f) return FN[f[1]] ?? 'other'
  return prev ?? 'other'
}

export interface Hidden {
  hidden: number
  topic: Topic
  key: string
}

/**
 * Severity and search filter (filterLines), then the topic filter. Each contiguous run of lines hidden only by the
 * topic filter becomes one placeholder row; lines hidden by severity or search leave no trace and do not split runs.
 */
export function viewRows<T extends { id: number; raw: string; level: Level; topic: Topic }>(
  lines: T[],
  on: Record<Group, boolean>,
  topics: Record<Topic, boolean>,
  query: string,
): { shown: T[]; rows: (T | Hidden)[] } {
  const base = filterLines(lines, on, query)
  const shown: T[] = []
  const rows: (T | Hidden)[] = []
  let run: Hidden | null = null
  for (const l of base) {
    if (topics[l.topic]) {
      shown.push(l)
      rows.push(l)
      run = null
    } else if (run && run.topic === l.topic) run.hidden++
    else rows.push((run = { hidden: 1, topic: l.topic, key: 'h' + l.id }))
  }
  return { shown, rows }
}

/** Splits text into plain and matching parts for highlighting (case-insensitive). */
export function segments(text: string, query: string): { t: string; hit: boolean }[] {
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  // Some characters change length when lowercased (e.g. İ); offsets would drift, so skip highlighting there.
  if (!q || lower.length !== text.length) return [{ t: text, hit: false }]
  const out: { t: string; hit: boolean }[] = []
  let at = 0
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length)) {
    if (i > at) out.push({ t: text.slice(at, i), hit: false })
    out.push({ t: text.slice(i, i + q.length), hit: true })
    at = i + q.length
  }
  if (at < text.length || !out.length) out.push({ t: text.slice(at), hit: false })
  return out
}

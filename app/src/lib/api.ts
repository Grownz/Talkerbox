// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { Channel, invoke } from '@tauri-apps/api/core'

export interface Settings {
  ollamaPath: string | null
  lastModel: string | null
  voice: string | null
  ttsEnabled: boolean
  ttsSpeed: number
}

export interface OllamaStatus {
  running: boolean
  version: string | null
  exe: string | null
  startedByApp: boolean
}

export interface ModelInfo {
  name: string
  size: number
  details: { parameterSize: string | null; quantizationLevel: string | null }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface Progress {
  message: string
  completed: number | null
  total: number | null
}

export interface TtsStatus {
  sidecarPresent: boolean
  modelReady: boolean
  running: boolean
  modelDir: string
  defaultModelUrl: string
  defaultVoicesUrl: string
}

/** Unique id used to cancel a running operation. */
export const newOpId = () => crypto.randomUUID()

function channel<T>(cb: (v: T) => void): Channel<T> {
  const ch = new Channel<T>()
  ch.onmessage = cb
  return ch
}

export const api = {
  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<void>('save_settings', { settings }),

  ollamaStatus: () => invoke<OllamaStatus>('ollama_status'),
  setOllamaPath: (path: string) => invoke<string>('set_ollama_path', { path }),
  ollamaStart: () => invoke<OllamaStatus>('ollama_start'),
  ollamaStop: () => invoke<OllamaStatus>('ollama_stop'),

  listModels: () => invoke<ModelInfo[]>('list_models'),
  deleteModel: (name: string) => invoke<void>('delete_model', { name }),
  /** Resolves to true if cancelled. */
  chat: (id: string, model: string, messages: ChatMessage[], onToken: (t: string) => void) =>
    invoke<boolean>('chat', { id, model, messages, onToken: channel(onToken) }),
  cancel: (id: string) => invoke<void>('cancel', { id }),
  pullModel: (id: string, input: string, onProgress: (p: Progress) => void) =>
    invoke<boolean>('pull_model', { id, input, onProgress: channel(onProgress) }),
  importGgufUrl: (id: string, url: string, modelName: string, onProgress: (p: Progress) => void) =>
    invoke<boolean>('import_gguf_url', { id, url, modelName, onProgress: channel(onProgress) }),

  ttsStatus: () => invoke<TtsStatus>('tts_status'),
  downloadTtsFile: (id: string, url: string, onProgress: (p: Progress) => void) =>
    invoke<boolean>('download_tts_file', { id, url, onProgress: channel(onProgress) }),
  ttsStart: () => invoke<TtsStatus>('tts_start'),
  ttsStop: () => invoke<TtsStatus>('tts_stop'),
  ttsVoices: () => invoke<string[]>('tts_voices'),
  ttsSynthesize: (text: string, voice: string, speed: number) =>
    invoke<ArrayBuffer>('tts_synthesize', { text, voice, speed }),
}

export function errText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : JSON.stringify(e)
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

export function progressText(p: Progress | null): string {
  if (!p) return ''
  if (p.total && p.completed != null) {
    const pct = ((p.completed / p.total) * 100).toFixed(1)
    return `${p.message} ${pct}% (${formatBytes(p.completed)} / ${formatBytes(p.total)})`
  }
  return p.message
}

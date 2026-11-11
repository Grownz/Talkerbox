// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { Channel, invoke } from '@tauri-apps/api/core'
import type { VoiceDetail } from './voices'

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
  /** Ollama model id (unchanged, used for API calls). */
  name: string
  /** Short human-friendly name for display. */
  displayName: string
  size: number
  details: { parameterSize: string | null; quantizationLevel: string | null }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type { VoiceDetail }

/** A Kokoro language pack (contents of its pack.json). */
export interface Pack {
  id: string
  name: string
  language: string
  model: string
  vocab?: string
  voices: string[]
}

/** Curated one-click language pack (see src-tauri/src/featured.rs). */
export interface FeaturedPack {
  id: string
  name: string
  language: string
  license: string
  source: string
  totalSize: number
  installed: boolean
}

export interface LinkInfo {
  kind: 'voice' | 'model' | 'vocab'
  name: string
  languages: string[]
}

export interface ChatResult {
  cancelled: boolean
  evalCount: number | null
  /** Nanoseconds. */
  evalDuration: number | null
}

/** One line of captured `ollama serve` output (event `ollama-log`). */
export interface LogLine {
  seq: number
  line: string
}

export interface Progress {
  message: string
  completed: number | null
  total: number | null
}

export interface TtsFile {
  name: string
  size: number
}

export interface TtsStatus {
  sidecarPresent: boolean
  sidecarError: string | null
  modelReady: boolean
  modelFile: TtsFile | null
  voicesFile: TtsFile | null
  running: boolean
  modelDir: string
  customDir: boolean
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
  chat: (id: string, model: string, messages: ChatMessage[], onToken: (t: string) => void) =>
    invoke<ChatResult>('chat', { id, model, messages, onToken: channel(onToken) }),
  ollamaLog: () => invoke<LogLine[]>('ollama_log'),
  ollamaLogClear: () => invoke<void>('ollama_log_clear'),
  cancel: (id: string) => invoke<void>('cancel', { id }),
  pullModel: (id: string, input: string, onProgress: (p: Progress) => void) =>
    invoke<boolean>('pull_model', { id, input, onProgress: channel(onProgress) }),
  importGgufUrl: (id: string, url: string, modelName: string, onProgress: (p: Progress) => void) =>
    invoke<boolean>('import_gguf_url', { id, url, modelName, onProgress: channel(onProgress) }),

  ttsStatus: () => invoke<TtsStatus>('tts_status'),
  /** null = back to the default folder in the app data dir. */
  setTtsModelDir: (path: string | null) => invoke<TtsStatus>('set_tts_model_dir', { path }),
  deleteTtsFiles: () => invoke<TtsStatus>('delete_tts_files'),
  listCustomVoices: () => invoke<TtsFile[]>('list_custom_voices'),
  /** Restarts a running sidecar afterwards so the voice is available. */
  downloadVoice: (id: string, url: string, onProgress: (p: Progress) => void) =>
    invoke<boolean>('download_voice', { id, url, onProgress: channel(onProgress) }),
  deleteCustomVoice: (name: string) => invoke<void>('delete_custom_voice', { name }),
  downloadTtsFile: (id: string, url: string, onProgress: (p: Progress) => void) =>
    invoke<boolean>('download_tts_file', { id, url, onProgress: channel(onProgress) }),
  ttsStart: () => invoke<TtsStatus>('tts_start'),
  ttsStop: () => invoke<TtsStatus>('tts_stop'),
  ttsVoices: () => invoke<{ voices: string[]; details: VoiceDetail[] }>('tts_voices'),
  /** The backend prepends one flag byte (1 = base-model fallback) to the WAV. */
  ttsSynthesize: async (text: string, voice: string, speed: number) => {
    const buf = await invoke<ArrayBuffer>('tts_synthesize', { text, voice, speed })
    return { fallback: new Uint8Array(buf, 0, 1)[0] === 1, wav: buf.slice(1) }
  },
  ttsLinkInfo: (url: string) => invoke<LinkInfo>('tts_link_info', { url }),
  listPacks: () => invoke<Pack[]>('list_packs'),
  createPack: (
    id: string,
    p: { name: string; language: string; modelUrl: string; vocabUrl: string | null; voiceUrls: string[] },
    onProgress: (p: Progress) => void,
  ) => invoke<boolean>('create_pack', { id, ...p, onProgress: channel(onProgress) }),
  addPackVoice: (id: string, packId: string, url: string, onProgress: (p: Progress) => void) =>
    invoke<boolean>('add_pack_voice', { id, packId, url, onProgress: channel(onProgress) }),
  deletePack: (packId: string) => invoke<void>('delete_pack', { packId }),
  listFeatured: () => invoke<FeaturedPack[]>('list_featured'),
  installFeatured: (id: string, featuredId: string, onProgress: (p: Progress) => void) =>
    invoke<boolean>('install_featured', { id, featuredId, onProgress: channel(onProgress) }),
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

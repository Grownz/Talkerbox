// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import type { AvatarBg } from './avatar.svelte'
import { Channel, invoke } from '@tauri-apps/api/core'
import type { Point, Rig } from './rig'
import type { VoiceDetail } from './voices'

export interface Settings {
  ollamaPath: string | null
  lastModel: string | null
  /** Let thinking models reason before answering (their default); false turns it off where the model supports that. */
  think: boolean
  voice: string | null
  ttsEnabled: boolean
  ttsSpeed: number
  /** Speech input language: 'de' or 'en'. */
  sttLanguage: string
  /** Seconds without transcript change before dictated text is sent. */
  sttIdleSecs: number
  /** Speech input microphone by name; null = system default. */
  sttDevice: string | null
  /** Start the Ollama server when the app opens. */
  ollamaAutostart: boolean
  /** Avatar window background. */
  avatarBg: AvatarBg
  /** 0-100: background alpha in transparent mode, figure opacity otherwise. */
  avatarOpacity: number
  /** Character shown in the avatar window; null = built-in demo figure. */
  avatarActive: string | null
  /** The avatar is shown in the sidebar instead of its own window (restored at start). */
  avatarDocked: boolean
}

export interface InputDevice {
  name: string
  /** The Windows default recording device. */
  default: boolean
}

export interface SttStatus {
  runtimeError: string | null
  listening: boolean
  /** `bytes`: size on disk of the installed model folder. */
  models: { lang: string; name: string; installed: boolean; bytes: number }[]
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
  /** Capabilities Ollama reports for an installed model, e.g. 'completion', 'tools', 'thinking'. */
  modelCapabilities: (model: string) => invoke<string[]>('model_capabilities', { model }),
  /**
   * Streams the answer to `onToken`. Thinking models send their reasoning to `onThinking` first (never part of the
   * answer); `think: false` turns reasoning off for models that support it (default true = the model's default).
   */
  chat: (
    id: string,
    model: string,
    messages: ChatMessage[],
    onToken: (t: string) => void,
    { think = true, onThinking = () => {} }: { think?: boolean; onThinking?: (t: string) => void } = {},
  ) => invoke<ChatResult>('chat', { id, model, messages, think, onToken: channel(onToken), onThinking: channel(onThinking) }),
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

  sttStatus: () => invoke<SttStatus>('stt_status'),
  sttDownload: (id: string, lang: string, onProgress: (p: Progress) => void) =>
    invoke<boolean>('stt_download', { id, lang, onProgress: channel(onProgress) }),
  sttDevices: () => invoke<InputDevice[]>('stt_devices'),
  /**
   * Transcript arrives as `stt://partial`/`stt://final` events, the text to send as `stt://send`.
   * `continuous`: keep listening after each send. Resolves to a hint if `device` was not found (default used).
   */
  sttStart: (lang: string, idleSecs: number, device: string | null, continuous: boolean) =>
    invoke<string | null>('stt_start', { lang, idleSecs, device, continuous }),
  /** While muted, speech input ignores the microphone. */
  sttMute: (muted: boolean) => invoke<void>('stt_mute', { muted }),
  sttStop: () => invoke<void>('stt_stop'),
  /** Deletes the installed model for `lang`; refused while listening with it. */
  sttRemoveModel: (lang: string) => invoke<void>('stt_remove_model', { lang }),

  /** Smart select (mask editor): ONNX Runtime and MobileSAM are downloaded on demand into `sam\`. */
  /** `bytes`: everything in `sam\` on disk. */
  samStatus: () => invoke<{ installed: boolean; bytes: number }>('sam_status'),
  /** Unloads and deletes the runtime and models (a re-download of about 60 MB is needed to use smart select again). */
  samRemove: () => invoke<void>('sam_remove'),
  samDownload: (id: string, onProgress: (p: Progress) => void) => invoke<boolean>('sam_download', { id, onProgress: channel(onProgress) }),
  /** Encodes an RGBA image (long side at most 1024) unless `key` was encoded last; resolves to the encoder ms (0 = cached). */
  samEncode: (key: string, rgba: Uint8ClampedArray, width: number, height: number) =>
    invoke<number>('sam_encode', new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
      headers: { 'x-key': key, 'x-width': String(width), 'x-height': String(height) },
    }),
  /** Mask of `width * height` bytes (1 = inside) for points in the encoded image's pixels. */
  samDecode: async (points: Point[], labels: number[], width: number, height: number) =>
    new Uint8Array(await invoke<ArrayBuffer>('sam_decode', { points, labels, width, height })),
  samRelease: () => invoke<void>('sam_release'),

  /** Avatar window only: its listeners are ready; the backend sends `avatar://ready` to the main window. */
  puppetReady: () => invoke<void>('puppet_ready'),
  puppetDock: () => invoke<void>('puppet_dock'),
  /** Saved avatar characters, sorted by name. */
  avatarList: () => invoke<Rig[]>('avatar_list'),
  /** Copies a PNG/JPEG/WebP (max 20 MB, 8192 px per side) picked in the open dialog into a new character. */
  avatarImportImage: (path: string) => invoke<Rig>('avatar_import_image', { path }),
  avatarLoad: (id: string) => invoke<Rig>('avatar_load', { id }),
  /** Id, image and createdAt stay as stored; kind is re-derived from the parts. */
  avatarSave: (rig: Rig) => invoke<Rig>('avatar_save', { rig }),
  avatarRename: (id: string, name: string) => invoke<Rig>('avatar_rename', { id, name }),
  avatarDelete: (id: string) => invoke<void>('avatar_delete', { id }),
  /** The character image as a Blob (for an object URL). */
  avatarImage: async (rig: Rig) => {
    const buf = await invoke<ArrayBuffer>('avatar_image', { id: rig.id })
    const ext = rig.image.file.split('.').pop()
    return new Blob([buf], { type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` })
  },
  /** The stored AI fill of a character (`fill.png`) as a Blob. */
  avatarFill: async (id: string) => new Blob([await invoke<ArrayBuffer>('avatar_fill', { id })], { type: 'image/png' }),
  /** Stores the AI fill PNG of a character; call right before `avatarSave` with a rig that references it. */
  avatarSaveFill: async (id: string, png: Blob) =>
    invoke<void>('avatar_save_fill', new Uint8Array(await png.arrayBuffer()), { headers: { 'x-id': id } }),

  /** AI fill under moved parts: LaMa downloaded on demand into `inpaint\` (the ONNX Runtime is shared with smart select). */
  inpaintStatus: () => invoke<{ installed: boolean; bytes: number; runtime: boolean }>('inpaint_status'),
  inpaintDownload: (id: string, onProgress: (p: Progress) => void) => invoke<boolean>('inpaint_download', { id, onProgress: channel(onProgress) }),
  inpaintRemove: () => invoke<void>('inpaint_remove'),
  /** 512 x 512 RGBA in (alpha 255 marks the pixels to fill), filled RGBA out. */
  inpaintRun: async (rgba: Uint8ClampedArray) =>
    new Uint8ClampedArray(await invoke<ArrayBuffer>('inpaint_run', new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength))),

  /** Face detection in the part editor: MediaPipe face models downloaded on demand into `face\` (runtime shared with smart select). */
  faceStatus: () => invoke<{ installed: boolean; bytes: number; runtime: boolean }>('face_status'),
  faceDownload: (id: string, onProgress: (p: Progress) => void) => invoke<boolean>('face_download', { id, onProgress: channel(onProgress) }),
  faceRemove: () => invoke<void>('face_remove'),
  /** 478 face landmarks (normalised to the image) of an RGBA image with a long side of at most 1024; rejects when no face is found. */
  faceDetect: (rgba: Uint8ClampedArray, width: number, height: number) =>
    invoke<{ points: Point[]; score: number; presence: number; ms: number }>('face_detect', new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
      headers: { 'x-width': String(width), 'x-height': String(height) },
    }),

  /** Opens an https link in the default browser; the backend only allows the hosts the About page uses. */
  openLink: (url: string) => invoke<void>('open_link', { url }),
  /** Opens THIRD_PARTY_NOTICES.md from the install folder; false when it is missing (dev runs). */
  openNotices: () => invoke<boolean>('open_notices'),
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

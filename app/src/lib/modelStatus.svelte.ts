// Status of an on-demand model that the backend loads, runs and frees in one call (AI fill, face detection):
// installed state and size, download with progress and cancel, remove after a confirmation, and running a job.
import { ask } from '@tauri-apps/plugin-dialog'
import { api, errText, newOpId, type Progress } from './api'

export type ModelState = 'unknown' | 'missing' | 'downloading' | 'ready' | 'busy' | 'error'

export interface ModelCommands {
  status: () => Promise<{ installed: boolean; bytes: number; runtime: boolean }>
  download: (id: string, onProgress: (p: Progress) => void) => Promise<unknown>
  remove: () => Promise<unknown>
}

export class ModelStatus {
  status = $state<ModelState>('unknown')
  err = $state('')
  bytes = $state(0)
  /** ONNX Runtime is already installed (the download is smaller). */
  runtime = $state(false)
  progress = $state<Progress | null>(null)
  private op: string | null = null
  private cmd: ModelCommands

  constructor(cmd: ModelCommands) {
    this.cmd = cmd
  }

  async refresh() {
    try {
      const s = await this.cmd.status()
      this.bytes = s.bytes
      this.runtime = s.runtime
      this.status = s.installed ? 'ready' : 'missing'
    } catch (e) {
      this.status = 'error'
      this.err = errText(e)
    }
  }

  async download() {
    const id = (this.op = newOpId())
    this.status = 'downloading'
    this.err = ''
    this.progress = null
    try {
      await this.cmd.download(id, (p) => (this.progress = p))
    } catch (e) {
      this.err = `Download failed: ${errText(e)}`
    }
    this.op = null
    await this.refresh()
    if (this.err) this.status = 'error'
  }

  /** Stops a running download (also when the panel closes). */
  cancel() {
    if (this.op) void api.cancel(this.op)
  }

  /** Deletes the model after asking `question`; false when the user kept it. */
  async remove(question: string, title: string): Promise<boolean> {
    const ok = await ask(question, { title, kind: 'warning', okLabel: 'Remove', cancelLabel: 'Keep' })
    if (!ok) return false
    try {
      await this.cmd.remove()
    } catch (e) {
      this.err = `Removing failed: ${errText(e)}`
    }
    await this.refresh()
    return true
  }

  /** Runs a job with the model: 'busy' while it runs, then 'ready', or 'error' with its message. */
  async run(job: () => Promise<void>) {
    this.status = 'busy'
    this.err = ''
    try {
      await job()
      this.status = 'ready'
    } catch (e) {
      this.status = 'error'
      this.err = errText(e)
    }
  }
}

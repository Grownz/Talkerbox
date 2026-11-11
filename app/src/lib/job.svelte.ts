// A cancellable long-running backend operation with progress, for the Models view.
import { api, errText, newOpId, type Progress } from './api'

export class Job {
  id = $state<string | null>(null)
  progress = $state<Progress | null>(null)
  result = $state('')
  error = $state('')

  get busy() {
    return this.id !== null
  }

  async run(fn: (id: string, onProgress: (p: Progress) => void) => Promise<boolean>, okText: string): Promise<boolean> {
    if (this.id) return false
    const id = newOpId()
    this.id = id
    this.progress = null
    this.result = ''
    this.error = ''
    try {
      const cancelled = await fn(id, (p) => (this.progress = p))
      this.result = cancelled ? 'Cancelled.' : okText
      return !cancelled
    } catch (e) {
      this.error = errText(e)
      return false
    } finally {
      this.id = null
    }
  }

  cancel() {
    if (this.id) api.cancel(this.id)
  }
}

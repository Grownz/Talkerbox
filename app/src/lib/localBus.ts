// In-page stand-in for Tauri's `listen`/`emitTo`: the docked avatar (PuppetView in the main window) gets the same
// avatar:// events and payloads as the avatar window, without a roundtrip through the backend.

type Handler = (e: { payload: never }) => void

export class LocalBus {
  private handlers = new Map<string, Set<Handler>>()

  /** Same shape as Tauri's `listen`, so PuppetView takes either. */
  listen = <T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> => {
    const set = this.handlers.get(event) ?? this.handlers.set(event, new Set()).get(event)!
    const h = cb as Handler
    set.add(h)
    return Promise.resolve(() => void set.delete(h))
  }

  /**
   * Delivered in a microtask, like Tauri events: a listener that writes state must not run inside the effect that
   * called `emit` (App.svelte's options effect), or Svelte re-runs that effect until it hits its update limit.
   */
  emit(event: string, payload?: unknown) {
    const hs = [...(this.handlers.get(event) ?? [])]
    queueMicrotask(() => {
      for (const h of hs) h({ payload: payload as never })
    })
  }
}

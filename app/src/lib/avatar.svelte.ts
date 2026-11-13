// Main-window side of the avatar (puppet) window: open state and events to it.
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'

export type AvatarBg = 'normal' | 'green' | 'transparent'
export interface AvatarOptions {
  bg: AvatarBg
  /** 0-100: background alpha in transparent mode, figure opacity otherwise. */
  opacity: number
  /** Saved character id; null = built-in demo figure. */
  character: string | null
  /** Bumped when a saved character changes, so the puppet reloads it. */
  rev: number
}

/**
 * `open` turns true when the puppet page reports ready and false when its window is destroyed.
 * `rev` is bumped after a character is saved (see AvatarOptions.rev).
 */
export const avatar = $state({ open: false, rev: 0 })

/** Opens the puppet window, or recreates it when the transparency differs (it can only be set at creation). */
export const puppetOpen = (transparent: boolean) => invoke<void>('puppet_open', { transparent })
export const puppetClose = () => invoke<void>('puppet_close')
export const toggleAvatar = (bg: AvatarBg) => (avatar.open ? puppetClose() : puppetOpen(bg === 'transparent'))

/** Tracks the puppet window; `options` is read whenever a (re)created puppet asks for its settings. */
export function watchPuppet(options: () => AvatarOptions): () => void {
  const off = [
    listen('avatar://ready', () => {
      avatar.open = true
      sendToPuppet('avatar://options', options())
    }),
    listen('avatar://closed', () => (avatar.open = false)),
  ]
  // After a reload of this window an avatar window may still be open: it answers with `avatar://ready`.
  void Promise.all(off).then(() => emitTo('puppet', 'avatar://ping').catch(() => {}))
  return () => off.forEach((p) => void p.then((u) => u()))
}

/** Events are only sent while the puppet window is open. */
export function sendToPuppet(event: string, payload?: unknown) {
  if (avatar.open) void emitTo('puppet', event, payload).catch(() => {})
}

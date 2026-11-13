// Main-window side of the avatar: the puppet window, the docked view in the sidebar, and events to both.
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { LocalBus } from './localBus'

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
 * `docked`: the avatar is shown in the main window's sidebar instead (App.svelte keeps `settings.avatarDocked` in sync).
 * `rev` is bumped after a character is saved (see AvatarOptions.rev).
 */
export const avatar = $state({ open: false, docked: false, rev: 0 })

/** The avatar is shown somewhere (window or sidebar), so speech should send it mouth data. */
export const avatarShown = () => avatar.open || avatar.docked

/** Opens the puppet window, or recreates it when the transparency differs (it can only be set at creation). */
export const puppetOpen = (transparent: boolean) => invoke<void>('puppet_open', { transparent })
/** Only recreates an already open window (transparency is fixed at creation); never opens one. */
export const puppetRetransparent = (transparent: boolean) => invoke<void>('puppet_retransparent', { transparent })
export const puppetClose = () => invoke<void>('puppet_close')
/** The avatar switch: off hides it wherever it is (the docked view or the window), on opens the window. */
export async function toggleAvatar(bg: AvatarBg) {
  if (avatar.docked) avatar.docked = false
  else if (avatar.open) await puppetClose()
  else await puppetOpen(bg === 'transparent')
}
/** Double-click on the docked avatar: back into its own window (with the saved bounds). */
export async function undock(bg: AvatarBg) {
  if (!avatar.docked) return
  avatar.docked = false
  try {
    await puppetOpen(bg === 'transparent')
  } catch (e) {
    avatar.docked = true
    throw e
  }
}

/** Event source of the docked view (PuppetView takes its `listen`). */
export const docked = new LocalBus()

/** Tracks the puppet window; `options` is read whenever a (re)created puppet asks for its settings. */
export function watchPuppet(options: () => AvatarOptions): () => void {
  const off = [
    listen('avatar://ready', () => {
      // A window that opens while the avatar is docked is stray (it must not show twice): close it again.
      if (avatar.docked) return void puppetClose().catch(() => {})
      avatar.open = true
      sendToPuppet('avatar://options', options())
    }),
    listen('avatar://closed', () => (avatar.open = false)),
    // The window's dock button; the backend closes the window right after.
    listen('avatar://dock', () => {
      avatar.open = false
      avatar.docked = true
    }),
    // WebView2 keeps a minimised page running; the docked view pauses its drawing like the window does.
    listen<boolean>('app://minimized', (e) => docked.emit('avatar://minimized', e.payload)),
  ]
  // After a reload of this window an avatar window may still be open: it answers with `avatar://ready`.
  void Promise.all(off).then(() => emitTo('puppet', 'avatar://ping').catch(() => {}))
  return () => off.forEach((p) => void p.then((u) => u()))
}

/** Events go to the puppet window while it is open and to the docked view while it is shown. */
export function sendToPuppet(event: string, payload?: unknown) {
  if (avatar.open) void emitTo('puppet', event, payload).catch(() => {})
  if (avatar.docked) docked.emit(event, payload)
}

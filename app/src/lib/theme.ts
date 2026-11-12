export type Theme = 'light' | 'dark'

const KEY = 'talkerbox.theme'

/** A stored explicit choice wins; anything else follows the system setting. */
export function resolveTheme(stored: unknown, prefersDark: boolean): Theme {
  return stored === 'light' || stored === 'dark' ? stored : prefersDark ? 'dark' : 'light'
}

// Storage can be unavailable (blocked or cleared site data); the theme then just follows the system.
export function loadTheme(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* not persisted */
  }
}

export const darkQuery = () => matchMedia('(prefers-color-scheme: dark)')

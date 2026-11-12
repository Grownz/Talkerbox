// Speech input helpers (pure; tested in tests/stt.test.ts).

export const STT_LANGUAGES = [
  { code: 'de', name: 'German', size: '46 MB' },
  { code: 'en', name: 'English (US)', size: '41 MB' },
] as const

export const sttLanguageName = (code: string) => STT_LANGUAGES.find((l) => l.code === code)?.name ?? code

/** Composer text while dictating: what was typed before listening started, then the live transcript. */
export function joinDraft(base: string, transcript: string): string {
  const b = base.trimEnd()
  const t = transcript.trim()
  return b && t ? `${b} ${t}` : b || t
}

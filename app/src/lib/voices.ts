// Kokoro voice ids are '<lang><gender>_<name>' (see hexgrad/Kokoro-82M VOICES.md), e.g. af_heart, bm_george.
// Language packs add voices whose language comes from the sidecar (espeak-ng code).
// Pure module (no asset imports) so it can be unit-tested with `node --test`.

/** espeak-ng language code -> display name and ISO 3166 country code of the flag. */
export const ESPEAK: Record<string, { name: string; country: string }> = {
  'en-us': { name: 'American English', country: 'us' },
  'en-gb': { name: 'British English', country: 'gb' },
  en: { name: 'English', country: 'gb' },
  es: { name: 'Spanish', country: 'es' },
  'fr-fr': { name: 'French', country: 'fr' },
  fr: { name: 'French', country: 'fr' },
  hi: { name: 'Hindi', country: 'in' },
  it: { name: 'Italian', country: 'it' },
  ja: { name: 'Japanese', country: 'jp' },
  'pt-br': { name: 'Brazilian Portuguese', country: 'br' },
  pt: { name: 'Portuguese', country: 'pt' },
  cmn: { name: 'Mandarin Chinese', country: 'cn' },
  zh: { name: 'Chinese', country: 'cn' },
  de: { name: 'German', country: 'de' },
  nl: { name: 'Dutch', country: 'nl' },
  pl: { name: 'Polish', country: 'pl' },
  ru: { name: 'Russian', country: 'ru' },
  uk: { name: 'Ukrainian', country: 'ua' },
  cs: { name: 'Czech', country: 'cz' },
  ko: { name: 'Korean', country: 'kr' },
  ar: { name: 'Arabic', country: 'sa' },
  tr: { name: 'Turkish', country: 'tr' },
  sv: { name: 'Swedish', country: 'se' },
  da: { name: 'Danish', country: 'dk' },
  nb: { name: 'Norwegian', country: 'no' },
  fi: { name: 'Finnish', country: 'fi' },
  el: { name: 'Greek', country: 'gr' },
  hu: { name: 'Hungarian', country: 'hu' },
  ro: { name: 'Romanian', country: 'ro' },
  he: { name: 'Hebrew', country: 'il' },
  fa: { name: 'Persian', country: 'ir' },
  vi: { name: 'Vietnamese', country: 'vn' },
  id: { name: 'Indonesian', country: 'id' },
  th: { name: 'Thai', country: 'th' },
}

/** Kokoro voice-id prefix letter -> espeak-ng code. */
export const PREFIX_CODES: Record<string, string> = {
  a: 'en-us',
  b: 'en-gb',
  e: 'es',
  f: 'fr-fr',
  h: 'hi',
  i: 'it',
  j: 'ja',
  p: 'pt-br',
  z: 'cmn',
}

/** Language for an espeak-ng code, falling back to its base code (`de-at` -> `de`); null if unknown. */
export function languageInfo(code: string | null | undefined): { name: string; country: string } | null {
  if (!code) return null
  const c = code.toLowerCase()
  return ESPEAK[c] ?? ESPEAK[c.split('-')[0]] ?? null
}

/** Per-voice data from the sidecar's GET /voices `details`. */
export interface VoiceDetail {
  id: string
  pack: string | null
  language: string | null
  fallback: boolean
}

export interface VoiceInfo {
  id: string
  language: string
  /** Group heading in the picker: the pack name for pack voices, else the language. */
  group: string
  /** null = unknown language, shown with a neutral globe. */
  country: string | null
  gender: 'female' | 'male' | null
  /** e.g. 'Heart'; ids that do not follow the Kokoro pattern are shown as is. */
  name: string
  /** e.g. 'Heart (female)'; ids that do not follow the Kokoro pattern are shown as is. */
  label: string
  /** Spoken with the base model although its language is unknown. */
  fallback: boolean
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function voiceInfo(id: string, detail?: VoiceDetail, packName?: string): VoiceInfo {
  const m = /^([a-z])([fm])_(.+)$/.exec(id)
  const gender = m ? (m[2] === 'f' ? 'female' : 'male') : null
  const name = m ? m[3].split('_').map(capitalise).join(' ') : id
  const label = m ? `${name} (${gender})` : id
  const fallback = detail?.fallback ?? false
  if (detail?.pack) {
    const lang = languageInfo(detail.language)
    const language = lang?.name ?? detail.language ?? 'Other'
    return { id, language, group: packName ?? language, country: lang?.country ?? null, gender, name, label, fallback }
  }
  const lang = m ? languageInfo(PREFIX_CODES[m[1]]) : null
  const language = lang?.name ?? 'Other'
  return { id, language, group: language, country: lang?.country ?? null, gender, name, label, fallback }
}

export interface VoiceGroup {
  name: string
  country: string | null
  voices: VoiceInfo[]
}

/** Groups voices: built-in languages in Kokoro order, then packs by name, then 'Other'; voice order is kept. */
export function groupVoices(ids: string[], details: VoiceDetail[] = [], packNames: Record<string, string> = {}): VoiceGroup[] {
  const byId = new Map(details.map((d) => [d.id, d]))
  const groups = new Map<string, VoiceInfo[]>()
  for (const id of ids) {
    const d = byId.get(id)
    const v = voiceInfo(id, d, d?.pack ? packNames[d.pack] : undefined)
    groups.set(v.group, [...(groups.get(v.group) ?? []), v])
  }
  const base = Object.values(PREFIX_CODES).map((c) => ESPEAK[c].name)
  const rank = (name: string) => (name === 'Other' ? 1000 : base.includes(name) ? base.indexOf(name) : 100)
  return [...groups.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((name) => ({ name, country: groups.get(name)![0].country, voices: groups.get(name)! }))
}

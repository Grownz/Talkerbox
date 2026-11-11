// Kokoro voice ids are '<lang><gender>_<name>' (see hexgrad/Kokoro-82M VOICES.md), e.g. af_heart, bm_george.
// Pure module (no asset imports) so it can be unit-tested with `node --test`.

/** Language prefix -> language name and ISO 3166 country code of the flag shown for it. */
export const LANGUAGES: Record<string, { name: string; country: string }> = {
  a: { name: 'American English', country: 'us' },
  b: { name: 'British English', country: 'gb' },
  e: { name: 'Spanish', country: 'es' },
  f: { name: 'French', country: 'fr' },
  h: { name: 'Hindi', country: 'in' },
  i: { name: 'Italian', country: 'it' },
  j: { name: 'Japanese', country: 'jp' },
  p: { name: 'Brazilian Portuguese', country: 'br' },
  z: { name: 'Mandarin Chinese', country: 'cn' },
}

export interface VoiceInfo {
  id: string
  language: string
  /** null = unknown language, shown with a neutral globe. */
  country: string | null
  gender: 'female' | 'male' | null
  /** e.g. 'Heart (female)' */
  label: string
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function voiceInfo(id: string): VoiceInfo {
  const m = /^([a-z])([fm])_(.+)$/.exec(id)
  if (!m) return { id, language: 'Other', country: null, gender: null, label: id }
  const lang = LANGUAGES[m[1]]
  const gender = m[2] === 'f' ? 'female' : 'male'
  const name = m[3].split('_').map(capitalise).join(' ')
  return { id, language: lang?.name ?? 'Other', country: lang?.country ?? null, gender, label: `${name} (${gender})` }
}

/** Groups voices by language in LANGUAGES order (unknown last), keeping the given order within a group. */
export function groupVoices(ids: string[]): { language: string; country: string | null; voices: VoiceInfo[] }[] {
  const order = [...Object.values(LANGUAGES).map((l) => l.name), 'Other']
  const groups = new Map<string, VoiceInfo[]>()
  for (const v of ids.map(voiceInfo)) groups.set(v.language, [...(groups.get(v.language) ?? []), v])
  return order
    .filter((name) => groups.has(name))
    .map((name) => ({ language: name, country: groups.get(name)![0].country, voices: groups.get(name)! }))
}

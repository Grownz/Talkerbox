// Run with `npm test` (Node's built-in test runner with TypeScript type stripping).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupVoices, languageInfo, voiceInfo, type VoiceDetail } from '../src/lib/voices.ts'

// All 54 Kokoro v1.0 voices (hexgrad/Kokoro-82M VOICES.md).
const KOKORO_V1 = `af_heart af_alloy af_aoede af_bella af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky
am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa
bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis
jf_alpha jf_gongitsune jf_nezumi jf_tebukuro jm_kumo
zf_xiaobei zf_xiaoni zf_xiaoxiao zf_xiaoyi zm_yunjian zm_yunxi zm_yunxia zm_yunyang
ef_dora em_alex em_santa ff_siwis hf_alpha hf_beta hm_omega hm_psi if_sara im_nicola pf_dora pm_alex pm_santa`.split(/\s+/)

test('every Kokoro v1.0 voice has a flag and gender', () => {
  assert.equal(KOKORO_V1.length, 54)
  for (const id of KOKORO_V1) {
    const v = voiceInfo(id)
    assert.ok(v.country, `no flag for ${id}`)
    assert.ok(v.gender, `no gender for ${id}`)
  }
})

test('labels and languages', () => {
  assert.deepEqual(voiceInfo('af_heart'), {
    id: 'af_heart',
    language: 'American English',
    country: 'us',
    gender: 'female',
    label: 'Heart (female)',
    group: 'American English',
    fallback: false,
  })
  assert.equal(voiceInfo('bm_george').country, 'gb')
  assert.equal(voiceInfo('pm_alex').language, 'Brazilian Portuguese')
  assert.equal(voiceInfo('zf_xiaoxiao').country, 'cn')
})

test('unknown voices fall back to a globe', () => {
  assert.equal(voiceInfo('xf_test').country, null)
  assert.equal(voiceInfo('xf_test').label, 'Test (female)')
  assert.deepEqual(voiceInfo('custom').country, null)
  assert.equal(voiceInfo('custom').label, 'custom')
})

test('grouping keeps language order and puts unknown last', () => {
  const g = groupVoices(['custom', 'bf_emma', 'af_heart', 'af_bella'])
  assert.deepEqual(
    g.map((x) => [x.name, x.voices.map((v) => v.id)]),
    [
      ['American English', ['af_heart', 'af_bella']],
      ['British English', ['bf_emma']],
      ['Other', ['custom']],
    ],
  )
})

test('espeak codes map to flags, with base-code fallback', () => {
  assert.equal(languageInfo('de')?.country, 'de')
  assert.equal(languageInfo('de-AT')?.country, 'de')
  assert.equal(languageInfo('ko')?.country, 'kr')
  assert.equal(languageInfo('uk')?.country, 'ua')
  assert.equal(languageInfo('cs')?.country, 'cz')
  assert.equal(languageInfo('xx'), null)
  assert.equal(languageInfo(null), null)
})

test('pack voices use the pack language and are grouped by pack name', () => {
  const details: VoiceDetail[] = [
    { id: 'martin', pack: 'de-martin', language: 'de', fallback: false },
    { id: 'af_heart', pack: null, language: 'en-us', fallback: false },
    { id: 'xm_odd', pack: null, language: null, fallback: true },
    { id: 'anna', pack: 'pl-anna', language: 'pl', fallback: false },
  ]
  const g = groupVoices(['xm_odd', 'anna', 'martin', 'af_heart'], details, { 'de-martin': 'German (Martin)' })
  assert.deepEqual(
    g.map((x) => [x.name, x.country, x.voices.map((v) => v.label)]),
    [
      ['American English', 'us', ['Heart (female)']],
      ['German (Martin)', 'de', ['martin']],
      ['Polish', 'pl', ['anna']], // pack name unknown -> language name
      ['Other', null, ['Odd (male)']],
    ],
  )
  assert.equal(voiceInfo('xm_odd', details[2]).fallback, true)
})

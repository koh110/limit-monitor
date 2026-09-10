import { expect, test } from 'vite-plus/test'
import {
  buildClaudeUsageObservation,
  parseClaudeResetsAt,
  parseClaudeUsageEnvelope,
  parseClaudeUsageText,
  toClaudeBucketIdentity
} from './claude-usage.js'

const OBSERVED_AT = '2026-09-01T11:36:47.683Z'

// `claude -p "/usage" --output-format json` の実測 result 本文(値のみ差し替え)
const REAL_USAGE_TEXT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 11% used · resets Sep 1, 9:19pm (Asia/Tokyo)',
  'Current week (all models): 13% used · resets Sep 6, 8:59pm (Asia/Tokyo)',
  'Current week (Fable): 16% used · resets Sep 6, 8:59pm (Asia/Tokyo)',
  '',
  "What's contributing to your limits usage?",
  'Approximate, based on local sessions on this machine — does not include other devices.',
  '',
  'Last 24h · 369 requests · 20 sessions',
  '  Top skills: /code-review 25%',
  '',
  'Last 7d · 1294 requests · 68 sessions',
  '  20% of your usage came from subagent-heavy sessions',
  '  Top skills: /code-review 8%',
  '  Top subagents: Explore 16%'
].join('\n')

test('実測の /usage 本文から rate limit 行だけを取り出す', () => {
  const limits = parseClaudeUsageText({ text: REAL_USAGE_TEXT, observedAt: OBSERVED_AT })
  expect(limits).toEqual([
    {
      bucketId: 'claude:session',
      label: '5h',
      usedPercent: 11,
      windowDurationSeconds: 18000,
      resetsAt: '2026-09-01T12:19:00.000Z'
    },
    {
      bucketId: 'claude:week',
      label: '7d',
      usedPercent: 13,
      windowDurationSeconds: 604800,
      resetsAt: '2026-09-06T11:59:00.000Z'
    },
    {
      bucketId: 'claude:week:fable',
      label: '7d Fable',
      usedPercent: 16,
      windowDurationSeconds: 604800,
      resetsAt: '2026-09-06T11:59:00.000Z'
    }
  ])
})

test('利用内訳(skill 名 / subagent 名 / session 数)は一切取り込まない', () => {
  const limits = parseClaudeUsageText({ text: REAL_USAGE_TEXT, observedAt: OBSERVED_AT })
  const serialized = JSON.stringify(limits)
  expect(serialized).not.toContain('code-review')
  expect(serialized).not.toContain('Explore')
  expect(serialized).not.toContain('requests')
  expect(serialized).not.toContain('sessions')
})

test('rate limit 行が無ければ空配列を返す', () => {
  expect(parseClaudeUsageText({ text: '', observedAt: OBSERVED_AT })).toEqual([])
  expect(
    parseClaudeUsageText({
      text: 'You are using an API key\n\nLast 24h · 10 requests',
      observedAt: OBSERVED_AT
    })
  ).toEqual([])
})

test('resets を持たない行でも usedPercent は取り込む', () => {
  const limits = parseClaudeUsageText({
    text: 'Current session: 42% used',
    observedAt: OBSERVED_AT
  })
  expect(limits).toEqual([
    {
      bucketId: 'claude:session',
      label: '5h',
      usedPercent: 42,
      windowDurationSeconds: 18000,
      resetsAt: null
    }
  ])
})

test('小数の usedPercent を扱う', () => {
  const limits = parseClaudeUsageText({
    text: 'Current week (all models): 12.5% used',
    observedAt: OBSERVED_AT
  })
  expect(limits[0]?.usedPercent).toBe(12.5)
})

test('同じ bucketId が重複したら先頭だけ採用する', () => {
  const limits = parseClaudeUsageText({
    text: 'Current session: 10% used\nCurrent session: 90% used',
    observedAt: OBSERVED_AT
  })
  expect(limits.length).toBe(1)
  expect(limits[0]?.usedPercent).toBe(10)
})

test('bucket 数は契約上限(16)で打ち切る', () => {
  const lines = Array.from({ length: 20 }, (_, index) => {
    return `Current week (model${index}): 1% used`
  })
  const limits = parseClaudeUsageText({ text: lines.join('\n'), observedAt: OBSERVED_AT })
  expect(limits.length).toBe(16)
})

test('bucketId は安定した ID へ正規化される', () => {
  expect(toClaudeBucketIdentity('Current session')).toEqual({
    bucketId: 'claude:session',
    label: '5h',
    windowDurationSeconds: 18000
  })
  expect(toClaudeBucketIdentity('Current week (all models)')).toEqual({
    bucketId: 'claude:week',
    label: '7d',
    windowDurationSeconds: 604800
  })
  expect(toClaudeBucketIdentity('Current week')).toEqual({
    bucketId: 'claude:week',
    label: '7d',
    windowDurationSeconds: 604800
  })
  // 表記揺れ(大文字小文字・連続空白)で bucketId が変わらない
  expect(toClaudeBucketIdentity('current   SESSION')?.bucketId).toBe('claude:session')
})

test('未知のラベルも捨てず slug 化して残す(window 長は null)', () => {
  expect(toClaudeBucketIdentity('Current month (Opus 5)')).toEqual({
    bucketId: 'claude:current-month-opus-5',
    label: 'Current month (Opus 5)',
    windowDurationSeconds: null
  })
})

test('未知の週次 scope は claude:week 配下へ入れる', () => {
  expect(toClaudeBucketIdentity('Current week (Opus 5.1)')).toEqual({
    bucketId: 'claude:week:opus-5-1',
    label: '7d Opus 5.1',
    windowDurationSeconds: 604800
  })
})

test('reset 時刻は timezone を解決して ISO へ変換する', () => {
  expect(parseClaudeResetsAt({ text: 'Sep 1, 9:19pm (Asia/Tokyo)', observedAt: OBSERVED_AT })).toBe(
    '2026-09-01T12:19:00.000Z'
  )
  expect(
    parseClaudeResetsAt({ text: 'Sep 1, 12:00am (Asia/Tokyo)', observedAt: OBSERVED_AT })
  ).toBe('2026-08-31T15:00:00.000Z')
  expect(
    parseClaudeResetsAt({ text: 'Sep 1, 12:00pm (Asia/Tokyo)', observedAt: OBSERVED_AT })
  ).toBe('2026-09-01T03:00:00.000Z')
  // 24 時間表記も許容する
  expect(parseClaudeResetsAt({ text: 'Sep 1, 21:19 (Asia/Tokyo)', observedAt: OBSERVED_AT })).toBe(
    '2026-09-01T12:19:00.000Z'
  )
})

test('正時は分が省略される実測表記を扱う', () => {
  // 実測: `Current week (all models): 14% used · resets Sep 6, 9pm (Asia/Tokyo)`
  expect(parseClaudeResetsAt({ text: 'Sep 6, 9pm (Asia/Tokyo)', observedAt: OBSERVED_AT })).toBe(
    '2026-09-06T12:00:00.000Z'
  )
  expect(parseClaudeResetsAt({ text: 'Sep 6, 12am (Asia/Tokyo)', observedAt: OBSERVED_AT })).toBe(
    '2026-09-05T15:00:00.000Z'
  )
  const limits = parseClaudeUsageText({
    text: 'Current week (all models): 14% used · resets Sep 6, 9pm (Asia/Tokyo)',
    observedAt: OBSERVED_AT
  })
  expect(limits[0]?.resetsAt).toBe('2026-09-06T12:00:00.000Z')
})

test('分も am/pm も無い表記は曖昧なので採用しない', () => {
  expect(parseClaudeResetsAt({ text: 'Sep 6, 9 (Asia/Tokyo)', observedAt: OBSERVED_AT })).toBe(null)
})

test('年跨ぎの reset 時刻で 1 年ずれない', () => {
  // 12/31 観測 → 1/3 reset は翌年
  expect(
    parseClaudeResetsAt({ text: 'Jan 3, 9:00am (Asia/Tokyo)', observedAt: '2026-12-31T13:00:00Z' })
  ).toBe('2027-01-03T00:00:00.000Z')
  // 1/2 観測 → 12/30 reset は前年(遅延到着した過去の値)
  expect(
    parseClaudeResetsAt({ text: 'Dec 30, 9:00am (Asia/Tokyo)', observedAt: '2027-01-02T13:00:00Z' })
  ).toBe('2026-12-30T00:00:00.000Z')
})

test('解釈できない reset 表記は null を返す', () => {
  expect(parseClaudeResetsAt({ text: 'in 3 hours', observedAt: OBSERVED_AT })).toBe(null)
  // timezone が無いと offset を確定できないため採用しない
  expect(parseClaudeResetsAt({ text: 'Sep 1, 9:19pm', observedAt: OBSERVED_AT })).toBe(null)
  expect(parseClaudeResetsAt({ text: 'Foo 1, 9:19pm (Asia/Tokyo)', observedAt: OBSERVED_AT })).toBe(
    null
  )
  expect(
    parseClaudeResetsAt({ text: 'Sep 1, 13:19pm (Asia/Tokyo)', observedAt: OBSERVED_AT })
  ).toBe(null)
  expect(parseClaudeResetsAt({ text: 'Sep 1, 9:19pm (Not/AZone)', observedAt: OBSERVED_AT })).toBe(
    null
  )
  expect(parseClaudeResetsAt({ text: 'Sep 1, 9:19pm (Asia/Tokyo)', observedAt: 'bogus' })).toBe(
    null
  )
})

test('CLI の JSON envelope から本文を取り出す', () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Current session: 11% used',
    session_id: 'should-be-ignored'
  })
  expect(parseClaudeUsageEnvelope(stdout)).toEqual({ ok: true, text: 'Current session: 11% used' })
})

test('envelope の異常は失敗として扱う', () => {
  expect(parseClaudeUsageEnvelope('not json')).toMatchObject({ ok: false, reason: 'invalid_json' })
  expect(parseClaudeUsageEnvelope('123')).toMatchObject({ ok: false, reason: 'unexpected_shape' })
  expect(
    parseClaudeUsageEnvelope(JSON.stringify({ is_error: true, subtype: 'error_during_execution' }))
  ).toMatchObject({ ok: false, reason: 'cli_error' })
  expect(parseClaudeUsageEnvelope(JSON.stringify({ result: '   ' }))).toMatchObject({
    ok: false,
    reason: 'empty_result'
  })
  expect(parseClaudeUsageEnvelope(JSON.stringify({}))).toMatchObject({
    ok: false,
    reason: 'empty_result'
  })
})

test('取り出した limit を Observation へ変換する', () => {
  const limits = parseClaudeUsageText({ text: REAL_USAGE_TEXT, observedAt: OBSERVED_AT })
  const observation = buildClaudeUsageObservation({
    limits,
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })
  expect(observation).toMatchObject({
    schemaVersion: 1,
    provider: 'claude',
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })
  expect(observation?.buckets.length).toBe(3)
  expect(observation?.buckets[0]).toEqual({
    bucketId: 'claude:session',
    label: '5h',
    usedPercent: 11,
    remainingPercent: 89,
    windowDurationSeconds: 18000,
    resetsAt: '2026-09-01T12:19:00.000Z',
    reached: false
  })
  // accountAlias は送らない(Hub が token から確定させる)
  expect(observation && 'accountAlias' in observation).toBe(false)
})

test('limit が空なら Observation を作らない(古い Hub 値を消さない)', () => {
  expect(
    buildClaudeUsageObservation({ limits: [], sourceId: 'dev-machine', observedAt: OBSERVED_AT })
  ).toBe(null)
})

test('100% 到達で reached を立て、範囲外は clamp する', () => {
  const observation = buildClaudeUsageObservation({
    limits: [
      {
        bucketId: 'claude:session',
        label: '5h',
        usedPercent: 120,
        windowDurationSeconds: 18000,
        resetsAt: null
      }
    ],
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })
  expect(observation?.buckets[0]).toMatchObject({
    usedPercent: 100,
    remainingPercent: 0,
    reached: true
  })
})

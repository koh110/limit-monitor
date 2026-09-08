import { expect, test } from 'vite-plus/test'
import {
  CODEX_INITIALIZE_ID,
  CODEX_RATE_LIMITS_ID,
  buildCodexInitializedNotification,
  buildCodexInitializeRequest,
  buildCodexRateLimitsRequest,
  parseCodexMessage,
  parseCodexRateLimitsResult
} from './codex-protocol.js'

// `codex app-server` の実測応答(値のみ差し替え)
const REAL_RESULT = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 13, windowDurationMins: 300, resetsAt: 1788274954 },
    secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1788747931 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null,
    spendControlReached: false,
    planType: 'plus',
    rateLimitReachedType: null
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 13, windowDurationMins: 300, resetsAt: 1788274954 },
      secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1788747931 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      planType: 'plus',
      rateLimitReachedType: null
    }
  },
  rateLimitResetCredits: { availableCount: 1, credits: [] }
}

test('handshake の request は app-server protocol の形になっている', () => {
  expect(
    JSON.parse(buildCodexInitializeRequest({ clientName: 'c', clientVersion: '1.2.3' }))
  ).toEqual({
    id: CODEX_INITIALIZE_ID,
    method: 'initialize',
    params: { clientInfo: { name: 'c', version: '1.2.3' } }
  })
  expect(JSON.parse(buildCodexInitializedNotification())).toEqual({ method: 'initialized' })
  expect(JSON.parse(buildCodexRateLimitsRequest())).toEqual({
    id: CODEX_RATE_LIMITS_ID,
    method: 'account/rateLimits/read',
    params: null
  })
})

test('id 付き result を result として分類する', () => {
  expect(parseCodexMessage('{"id":2,"result":{"rateLimits":null}}')).toEqual({
    kind: 'result',
    id: 2,
    result: { rateLimits: null }
  })
})

test('notification は other として無視する', () => {
  // 実測で割り込む notification
  expect(parseCodexMessage('{"method":"configWarning","params":{"summary":"x"}}')).toEqual({
    kind: 'other'
  })
  expect(
    parseCodexMessage('{"method":"remoteControl/status/changed","params":{"status":"disabled"}}')
  ).toEqual({ kind: 'other' })
  expect(parseCodexMessage('not json')).toEqual({ kind: 'other' })
  expect(parseCodexMessage('{"id":"abc","result":{}}')).toEqual({ kind: 'other' })
  expect(parseCodexMessage('{"id":2}')).toEqual({ kind: 'other' })
})

test('error 応答は error として分類し message を切り詰める', () => {
  const long = 'x'.repeat(500)
  const message = parseCodexMessage(
    JSON.stringify({ id: 2, error: { code: -32000, message: long } })
  )
  expect(message.kind).toBe('error')
  if (message.kind !== 'error') {
    throw new Error('expected error')
  }
  expect(message.code).toBe(-32000)
  expect(message.message.length).toBe(200)
})

test('error の code / message が欠けていても扱える', () => {
  expect(parseCodexMessage(JSON.stringify({ id: 1, error: {} }))).toEqual({
    kind: 'error',
    id: 1,
    code: null,
    message: 'unknown app-server error'
  })
})

test('実測 result を検証して収集対象フィールドだけ残す', () => {
  const parsed = parseCodexRateLimitsResult(REAL_RESULT)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) {
    throw new Error('expected success')
  }
  expect(parsed.payload.rateLimitsByLimitId?.['codex']).toEqual({
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 13, windowDurationMins: 300, resetsAt: 1788274954 },
    secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1788747931 },
    rateLimitReachedType: null
  })
  // credits / planType / balance は Hub へ渡さない(データ最小化)
  const serialized = JSON.stringify(parsed.payload)
  expect(serialized).not.toContain('planType')
  expect(serialized).not.toContain('credits')
  expect(serialized).not.toContain('spendControlReached')
})

test('rateLimits だけの応答も扱える', () => {
  const parsed = parseCodexRateLimitsResult({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 5 } }
  })
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) {
    throw new Error('expected success')
  }
  expect(parsed.payload.rateLimitsByLimitId).toBe(null)
})

test('rate limit が空の応答は失敗として扱う(fake 値を作らない)', () => {
  expect(parseCodexRateLimitsResult({})).toMatchObject({ ok: false, reason: 'no_rate_limits' })
  expect(parseCodexRateLimitsResult({ rateLimitsByLimitId: {} })).toMatchObject({
    ok: false,
    reason: 'no_rate_limits'
  })
  expect(parseCodexRateLimitsResult({ rateLimits: null, rateLimitsByLimitId: null })).toMatchObject(
    { ok: false, reason: 'no_rate_limits' }
  )
})

test('想定外の形は失敗として扱う', () => {
  expect(parseCodexRateLimitsResult(null)).toMatchObject({ ok: false, reason: 'unexpected_shape' })
  expect(parseCodexRateLimitsResult('nope')).toMatchObject({
    ok: false,
    reason: 'unexpected_shape'
  })
  // limitId(bucketId の構成要素)が無い応答は採用しない
  expect(parseCodexRateLimitsResult({ rateLimits: { primary: { usedPercent: 5 } } })).toMatchObject(
    {
      ok: false,
      reason: 'unexpected_shape'
    }
  )
})

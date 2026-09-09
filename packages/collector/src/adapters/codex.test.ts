import { expect, test } from 'vite-plus/test'
import { buildCodexObservation } from './codex.js'

const base = {
  accountAlias: 'default',
  sourceId: 'mock-dev',
  observedAt: '2026-08-23T04:00:00.000Z'
} as const

test('rateLimitsByLimitId の全 limit・全 window を bucket にする', () => {
  const observation = buildCodexObservation({
    ...base,
    payload: {
      rateLimitsByLimitId: {
        codex_default: {
          limitId: 'codex_default',
          primary: {
            usedPercent: 28.5,
            windowDurationMins: 300,
            resetsAt: '2026-08-23T07:14:00.000Z'
          },
          secondary: {
            usedPercent: 61.2,
            windowDurationMins: 10080,
            resetsAt: '2026-08-26T04:00:00.000Z'
          }
        },
        codex_mini: {
          limitId: 'codex_mini',
          primary: { usedPercent: 5, windowDurationMins: 60 }
        }
      }
    }
  })

  expect(observation).not.toBe(null)
  expect(observation?.provider).toBe('codex')
  expect(observation?.buckets).toEqual([
    {
      bucketId: 'codex:codex_default:primary',
      label: '5h',
      usedPercent: 28.5,
      remainingPercent: 71.5,
      windowDurationSeconds: 18000,
      resetsAt: '2026-08-23T07:14:00.000Z',
      reached: false
    },
    {
      bucketId: 'codex:codex_default:secondary',
      label: '7d',
      usedPercent: 61.2,
      remainingPercent: 38.8,
      windowDurationSeconds: 604800,
      resetsAt: '2026-08-26T04:00:00.000Z',
      reached: false
    },
    {
      bucketId: 'codex:codex_mini:primary',
      label: '1h',
      usedPercent: 5,
      remainingPercent: 95,
      windowDurationSeconds: 3600,
      resetsAt: null,
      reached: false
    }
  ])
})

test('rateLimitsByLimitId がなければ単一 rateLimits を扱う(secondary なし)', () => {
  const observation = buildCodexObservation({
    ...base,
    payload: {
      rateLimits: {
        limitId: 'codex_default',
        primary: { usedPercent: 100, windowDurationMins: 300 }
      }
    }
  })

  expect(observation?.buckets).toEqual([
    {
      bucketId: 'codex:codex_default:primary',
      label: '5h',
      usedPercent: 100,
      remainingPercent: 0,
      windowDurationSeconds: 18000,
      resetsAt: null,
      reached: true
    }
  ])
})

test('windowDurationMins がない window は window 名を label にする', () => {
  const observation = buildCodexObservation({
    ...base,
    payload: {
      rateLimits: {
        limitId: 'codex_default',
        primary: { usedPercent: 10 }
      }
    }
  })
  expect(observation?.buckets[0]).toMatchObject({
    label: 'primary',
    windowDurationSeconds: null
  })
})

test('usedPercent は 0..100 に clamp して remainingPercent を導出する', () => {
  const observation = buildCodexObservation({
    ...base,
    payload: {
      rateLimits: {
        limitId: 'codex_default',
        primary: { usedPercent: 120, windowDurationMins: 300 }
      }
    }
  })
  expect(observation?.buckets[0]).toMatchObject({
    usedPercent: 100,
    remainingPercent: 0,
    reached: true
  })
})

test('有効な window がなければ null を返す', () => {
  expect(buildCodexObservation({ ...base, payload: {} })).toBe(null)
  expect(
    buildCodexObservation({
      ...base,
      payload: { rateLimits: { limitId: 'codex_default' } }
    })
  ).toBe(null)
})

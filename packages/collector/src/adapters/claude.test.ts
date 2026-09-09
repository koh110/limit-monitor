import { expect, test } from 'vite-plus/test'
import { buildClaudeObservation } from './claude.js'

const base = {
  accountAlias: 'default',
  sourceId: 'mock-dev',
  observedAt: '2026-08-23T04:00:00.000Z'
} as const

test('five_hour と seven_day の両方を bucket にする', () => {
  const observation = buildClaudeObservation({
    ...base,
    statusLine: {
      rate_limits: {
        five_hour: {
          used_percentage: 42,
          resets_at: '2026-08-23T05:30:00.000Z'
        },
        seven_day: {
          used_percentage: 12.5,
          resets_at: '2026-08-26T04:00:00.000Z'
        }
      }
    }
  })

  expect(observation?.provider).toBe('claude')
  expect(observation?.buckets).toEqual([
    {
      bucketId: 'claude:five_hour',
      label: '5h',
      usedPercent: 42,
      remainingPercent: 58,
      windowDurationSeconds: 18000,
      resetsAt: '2026-08-23T05:30:00.000Z',
      reached: false
    },
    {
      bucketId: 'claude:seven_day',
      label: '7d',
      usedPercent: 12.5,
      remainingPercent: 87.5,
      windowDurationSeconds: 604800,
      resetsAt: '2026-08-26T04:00:00.000Z',
      reached: false
    }
  ])
})

test('five_hour だけでも観測を作る', () => {
  const observation = buildClaudeObservation({
    ...base,
    statusLine: {
      rate_limits: { five_hour: { used_percentage: 10 } }
    }
  })
  expect(observation?.buckets.length).toBe(1)
  expect(observation?.buckets[0]).toMatchObject({
    bucketId: 'claude:five_hour',
    resetsAt: null
  })
})

test('seven_day だけでも観測を作る', () => {
  const observation = buildClaudeObservation({
    ...base,
    statusLine: {
      rate_limits: { seven_day: { used_percentage: 90 } }
    }
  })
  expect(observation?.buckets.length).toBe(1)
  expect(observation?.buckets[0]).toMatchObject({
    bucketId: 'claude:seven_day'
  })
})

test('rate_limits が欠落した statusLine では null を返し送信しない', () => {
  expect(buildClaudeObservation({ ...base, statusLine: {} })).toBe(null)
  expect(buildClaudeObservation({ ...base, statusLine: { rate_limits: null } })).toBe(null)
  expect(buildClaudeObservation({ ...base, statusLine: { rate_limits: {} } })).toBe(null)
})

test('unix 秒の resets_at は ISO 文字列へ正規化する', () => {
  const observation = buildClaudeObservation({
    ...base,
    statusLine: {
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: 1787812200 }
      }
    }
  })
  expect(observation?.buckets[0]).toMatchObject({
    resetsAt: new Date(1787812200 * 1000).toISOString()
  })
})

test('100% 到達で reached を立てる', () => {
  const observation = buildClaudeObservation({
    ...base,
    statusLine: {
      rate_limits: { five_hour: { used_percentage: 100 } }
    }
  })
  expect(observation?.buckets[0]).toMatchObject({
    usedPercent: 100,
    remainingPercent: 0,
    reached: true
  })
})

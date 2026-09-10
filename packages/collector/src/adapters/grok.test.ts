import { expect, test } from 'vite-plus/test'
import { buildGrokObservation, parseGrokBillingLine } from './grok.js'

const OBSERVED_AT = '2026-09-10T07:00:00.000Z'

test('billing unified log の ctx を抽出する', () => {
  const line = JSON.stringify({
    level: 'INFO',
    event: 'billing: fetched credits config',
    ctx: {
      config: {
        creditUsagePercent: 37.5,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-09-08T00:00:00Z',
          end: '2026-09-15T00:00:00Z'
        }
      }
    }
  })
  expect(parseGrokBillingLine(line)).toMatchObject({
    config: { creditUsagePercent: 37.5 }
  })
})

test('billing event 以外や壊れた JSON は無視する', () => {
  expect(parseGrokBillingLine('{broken')).toBeNull()
  expect(parseGrokBillingLine(JSON.stringify({ event: 'other', ctx: {} }))).toBeNull()
})

test('weekly credits を Grok observation に正規化する', () => {
  const observation = buildGrokObservation({
    billing: {
      config: {
        creditUsagePercent: 37.5,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-09-08T00:00:00Z',
          end: '2026-09-15T00:00:00Z'
        }
      }
    },
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })
  expect(observation).toMatchObject({
    provider: 'grok',
    buckets: [
      {
        bucketId: 'grok:credits',
        label: '7d',
        usedPercent: 37.5,
        remainingPercent: 62.5,
        windowDurationSeconds: 604800,
        resetsAt: '2026-09-15T00:00:00.000Z',
        reached: false
      }
    ]
  })
})

test('usage percent を 0..100 に clamp する', () => {
  const observation = buildGrokObservation({
    billing: { config: { creditUsagePercent: 120 } },
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })
  expect(observation?.buckets[0]).toMatchObject({
    usedPercent: 100,
    remainingPercent: 0,
    reached: true
  })
})

import { expect, test } from 'vite-plus/test'
import { buildGrokObservation } from './grok.js'

const OBSERVED_AT = '2026-09-10T06:00:00.000Z'

test('creditUsagePercent と weekly period を Observation に変換する', () => {
  const observation = buildGrokObservation({
    payload: {
      config: {
        creditUsagePercent: 42.5,
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
    sourceId: 'dev-machine',
    buckets: [
      {
        bucketId: 'grok:weekly',
        label: 'Weekly',
        usedPercent: 42.5,
        remainingPercent: 57.5,
        windowDurationSeconds: 604800,
        resetsAt: '2026-09-15T00:00:00.000Z',
        reached: false
      }
    ]
  })
})

test('旧 monthlyLimit/used 応答へ fallback する', () => {
  const observation = buildGrokObservation({
    payload: {
      config: {
        monthlyLimit: { val: 10000 },
        used: { val: 2500 },
        billingPeriodStart: '2026-09-01T00:00:00Z',
        billingPeriodEnd: '2026-10-01T00:00:00Z'
      }
    },
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })

  expect(observation?.buckets[0]).toMatchObject({
    bucketId: 'grok:monthly',
    label: 'Monthly',
    usedPercent: 25,
    remainingPercent: 75
  })
})

test('利用率が無い応答は送信対象にしない', () => {
  expect(
    buildGrokObservation({
      payload: { config: {} },
      sourceId: 'dev-machine',
      observedAt: OBSERVED_AT
    })
  ).toBeNull()
})

test('利用率は 0..100 に clamp する', () => {
  const observation = buildGrokObservation({
    payload: { config: { creditUsagePercent: 120 } },
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })
  expect(observation?.buckets[0]).toMatchObject({
    usedPercent: 100,
    remainingPercent: 0,
    reached: true
  })
})

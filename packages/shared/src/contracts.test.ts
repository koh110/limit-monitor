import { expect, test } from 'vite-plus/test'
import {
  accountAliasSchema,
  observationBucketSchema,
  observationSchema,
  statusResponseSchema
} from './contracts.js'

const validBucket = {
  bucketId: 'codex:primary',
  label: '5h',
  usedPercent: 28.5,
  remainingPercent: 71.5,
  windowDurationSeconds: 18000,
  resetsAt: '2026-08-23T07:14:00Z',
  reached: false
} as const

const validObservation = {
  schemaVersion: 1,
  provider: 'codex',
  accountAlias: 'default',
  sourceId: 'dev-server',
  observedAt: '2026-08-23T04:00:00Z',
  buckets: [validBucket],
  credits: null
} as const

test('仕様 6.1 の observation payload を受理する', () => {
  const parsed = observationSchema.safeParse(validObservation)
  expect(parsed.success).toBe(true)
})

test('Grok provider を受理する', () => {
  const parsed = observationSchema.safeParse({
    ...validObservation,
    provider: 'grok',
    buckets: [{ ...validBucket, bucketId: 'grok:weekly', label: 'Weekly' }]
  })
  expect(parsed.success).toBe(true)
})

test('未知フィールドは互換性のため無視する', () => {
  const parsed = observationSchema.safeParse({
    ...validObservation,
    futureField: 'ignored'
  })
  expect(parsed.success).toBe(true)
  if (parsed.success) {
    expect('futureField' in parsed.data).toBe(false)
  }
})

test('provider は codex | claude | grok のみ', () => {
  const parsed = observationSchema.safeParse({
    ...validObservation,
    provider: 'gemini'
  })
  expect(parsed.success).toBe(false)
})

test('accountAlias にメールアドレス等の生 ID を許可しない', () => {
  expect(accountAliasSchema.safeParse('user@example.com').success).toBe(false)
  expect(accountAliasSchema.safeParse('').success).toBe(false)
  expect(accountAliasSchema.safeParse('work.max_plan-2').success).toBe(true)
})

test('bucket 単体の検証: percent は 0..100', () => {
  expect(observationBucketSchema.safeParse({ ...validBucket, usedPercent: 100.1 }).success).toBe(
    false
  )
  expect(
    observationBucketSchema.safeParse({
      ...validBucket,
      remainingPercent: -0.1
    }).success
  ).toBe(false)
  expect(observationBucketSchema.safeParse({ ...validBucket, usedPercent: 0 }).success).toBe(true)
})

test('bucket の resetsAt / windowDurationSeconds は null を許容する', () => {
  const parsed = observationBucketSchema.safeParse({
    ...validBucket,
    resetsAt: null,
    windowDurationSeconds: null
  })
  expect(parsed.success).toBe(true)
})

test('envelope は buckets の中身を検証しない(partial acceptance のため)', () => {
  const parsed = observationSchema.safeParse({
    ...validObservation,
    buckets: [validBucket, { broken: true }]
  })
  expect(parsed.success).toBe(true)
})

test('buckets が空の observation は拒否する', () => {
  const parsed = observationSchema.safeParse({
    ...validObservation,
    buckets: []
  })
  expect(parsed.success).toBe(false)
})

test('status response の契約(仕様 7.3)', () => {
  const parsed = statusResponseSchema.safeParse({
    schemaVersion: 1,
    generatedAt: '2026-08-23T04:01:00Z',
    accounts: [
      {
        provider: 'codex',
        accountAlias: 'default',
        buckets: [
          {
            bucketId: 'codex:primary',
            label: '5h',
            usedPercent: 28.5,
            remainingPercent: 71.5,
            windowDurationSeconds: 18000,
            resetsAt: '2026-08-23T07:14:00Z',
            observedAt: '2026-08-23T04:00:00Z',
            reached: false,
            freshness: 'fresh'
          }
        ]
      }
    ]
  })
  expect(parsed.success).toBe(true)
})

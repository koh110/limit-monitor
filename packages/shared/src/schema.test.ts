import { expect, test } from 'vite-plus/test'
import * as z from 'zod/mini'
import type {
  IngestResult,
  Observation,
  ObservationBucket,
  Provider,
  StatusAccount,
  StatusBucket,
  StatusResponse
} from './contracts.js'
import {
  freshnessSchema,
  ingestResultSchema,
  observationBucketSchema,
  observationSchema,
  statusResponseSchema
} from './contracts.js'
import type { components } from './generated/schema.js'

type Schemas = components['schemas']

// TypeSpec(契約の単一ソース)から生成した型と、runtime 検証に使う zod schema の
// 推論型が双方向に代入可能であることを型レベルで固定する。どちらか一方だけを
// 変更すると tsc(`npm run tsc -w shared`)が落ちるため、契約の drift を防げる。
function assertMutuallyAssignable<Inferred, Generated>(
  toGenerated: (value: Inferred) => Generated,
  toInferred: (value: Generated) => Inferred
) {
  return [toGenerated, toInferred] as const
}

const provider = assertMutuallyAssignable<Provider, Schemas['Provider']>(
  (value) => value,
  (value) => value
)
const freshness = assertMutuallyAssignable<z.infer<typeof freshnessSchema>, Schemas['Freshness']>(
  (value) => value,
  (value) => value
)
const observationBucket = assertMutuallyAssignable<ObservationBucket, Schemas['ObservationBucket']>(
  (value) => value,
  (value) => value
)
const observation = assertMutuallyAssignable<Observation, Schemas['Observation']>(
  (value) => value,
  (value) => value
)
const ingestResult = assertMutuallyAssignable<IngestResult, Schemas['IngestResult']>(
  (value) => value,
  (value) => value
)
const statusBucket = assertMutuallyAssignable<StatusBucket, Schemas['StatusBucket']>(
  (value) => value,
  (value) => value
)
const statusAccount = assertMutuallyAssignable<StatusAccount, Schemas['StatusAccount']>(
  (value) => value,
  (value) => value
)
const statusResponse = assertMutuallyAssignable<StatusResponse, Schemas['StatusResponse']>(
  (value) => value,
  (value) => value
)

test('TypeSpec 生成型と zod 契約型は相互に代入できる', () => {
  expect([
    provider,
    freshness,
    observationBucket,
    observation,
    ingestResult,
    statusBucket,
    statusAccount,
    statusResponse
  ]).toHaveLength(8)
})

test('TypeSpec の Observation 形状は zod の runtime 検証を通る', () => {
  const value: Schemas['Observation'] = {
    schemaVersion: 1,
    provider: 'codex',
    accountAlias: 'default',
    sourceId: 'dev-machine',
    observedAt: '2026-08-23T04:00:00.000Z',
    buckets: [
      {
        bucketId: 'codex:primary',
        label: '5h',
        usedPercent: 28.5,
        remainingPercent: 71.5,
        windowDurationSeconds: 18000,
        resetsAt: '2026-08-23T07:14:00.000Z',
        reached: false
      } satisfies Schemas['ObservationBucket']
    ],
    credits: null
  }

  const parsed = observationSchema.safeParse(value)
  expect(parsed.success).toBe(true)
  expect(observationBucketSchema.safeParse(value.buckets[0]).success).toBe(true)
})

test('TypeSpec の StatusResponse / IngestResult 形状は zod の runtime 検証を通る', () => {
  const status: Schemas['StatusResponse'] = {
    schemaVersion: 1,
    generatedAt: '2026-08-23T04:00:00.000Z',
    accounts: [
      {
        provider: 'claude',
        accountAlias: 'default',
        buckets: [
          {
            bucketId: 'claude:5h',
            label: '5h',
            usedPercent: 10,
            remainingPercent: 90,
            windowDurationSeconds: null,
            resetsAt: null,
            observedAt: '2026-08-23T04:00:00.000Z',
            reached: false,
            freshness: 'fresh'
          }
        ]
      }
    ]
  }
  expect(statusResponseSchema.safeParse(status).success).toBe(true)

  const ingest: Schemas['IngestResult'] = {
    schemaVersion: 1,
    accepted: ['codex:primary'],
    skipped: [{ bucketId: 'codex:secondary', reason: 'stale_observation' }],
    rejected: [{ index: 2, reason: 'label: too small' }]
  }
  expect(ingestResultSchema.safeParse(ingest).success).toBe(true)
})

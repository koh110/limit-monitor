import { HTTPException } from 'hono/http-exception'
import type { Observation } from 'shared/src/contracts'
import { expect, test } from 'vite-plus/test'
import { createTestDb } from '../../../test/util.js'
import { getStatus } from '../status/get.js'
import { ingestObservation } from './ingest.js'

const now = new Date('2026-08-23T04:10:00.000Z')

function createObservation(overrides: Partial<Observation> = {}): Observation {
  return {
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
      }
    ],
    ...overrides
  }
}

async function statusBuckets(db: Parameters<typeof getStatus>[0]['db']) {
  const status = await getStatus({ db, now })
  return status.accounts.flatMap((account) => {
    return account.buckets
  })
}

test('token の sourceId と payload の sourceId が一致しない場合は 403', async () => {
  const { db, cleanup } = createTestDb()
  const error = await ingestObservation({
    db,
    observation: createObservation({ sourceId: 'other-machine' }),
    tokenSourceId: 'dev-machine',
    now
  }).catch((err: unknown) => {
    return err
  })
  expect(error).toBeInstanceOf(HTTPException)
  if (error instanceof HTTPException) {
    expect(error.status).toBe(403)
  }
  expect(await statusBuckets(db)).toEqual([])
  cleanup()
})

test('Hub 時刻より 5 分以上未来の observedAt は 400 で拒否する', async () => {
  const { db, cleanup } = createTestDb()
  const error = await ingestObservation({
    db,
    observation: createObservation({
      // now(04:10)より 6 分未来
      observedAt: '2026-08-23T04:16:00.000Z'
    }),
    tokenSourceId: 'dev-machine',
    now
  }).catch((err: unknown) => {
    return err
  })
  expect(error).toBeInstanceOf(HTTPException)
  if (error instanceof HTTPException) {
    expect(error.status).toBe(400)
  }
  expect(await statusBuckets(db)).toEqual([])
  cleanup()
})

test('5 分未満の未来 observedAt は clock skew として受理する', async () => {
  const { db, cleanup } = createTestDb()
  const result = await ingestObservation({
    db,
    observation: createObservation({
      observedAt: '2026-08-23T04:14:00.000Z'
    }),
    tokenSourceId: 'dev-machine',
    now
  })
  expect(result.accepted).toEqual(['codex:primary'])
  cleanup()
})

test('古い観測値の遅延到着は最新値を上書きしない', async () => {
  const { db, cleanup } = createTestDb()
  await ingestObservation({
    db,
    observation: createObservation({
      observedAt: '2026-08-23T04:05:00.000Z',
      buckets: [
        {
          bucketId: 'codex:primary',
          label: '5h',
          usedPercent: 40,
          remainingPercent: 60
        }
      ]
    }),
    tokenSourceId: 'dev-machine',
    now
  })

  const result = await ingestObservation({
    db,
    observation: createObservation({
      observedAt: '2026-08-23T04:00:00.000Z',
      buckets: [
        {
          bucketId: 'codex:primary',
          label: '5h',
          usedPercent: 10,
          remainingPercent: 90
        }
      ]
    }),
    tokenSourceId: 'dev-machine',
    now: new Date('2026-08-23T04:11:00.000Z')
  })

  expect(result.accepted).toEqual([])
  expect(result.skipped).toEqual([{ bucketId: 'codex:primary', reason: 'stale_observation' }])
  const buckets = await statusBuckets(db)
  expect(buckets[0]?.usedPercent).toBe(40)
  expect(buckets[0]?.observedAt).toBe('2026-08-23T04:05:00.000Z')
  cleanup()
})

test('observedAt が同一時刻なら新しい receivedAt を採用する', async () => {
  const { db, cleanup } = createTestDb()
  const observedAt = '2026-08-23T04:05:00.000Z'
  await ingestObservation({
    db,
    observation: createObservation({
      observedAt,
      buckets: [
        {
          bucketId: 'codex:primary',
          label: '5h',
          usedPercent: 40,
          remainingPercent: 60
        }
      ]
    }),
    tokenSourceId: 'dev-machine',
    now
  })

  const result = await ingestObservation({
    db,
    observation: createObservation({
      observedAt,
      sourceId: 'laptop',
      buckets: [
        {
          bucketId: 'codex:primary',
          label: '5h',
          usedPercent: 55,
          remainingPercent: 45
        }
      ]
    }),
    tokenSourceId: 'laptop',
    now: new Date('2026-08-23T04:11:00.000Z')
  })

  expect(result.accepted).toEqual(['codex:primary'])
  const buckets = await statusBuckets(db)
  expect(buckets[0]?.usedPercent).toBe(55)
  cleanup()
})

test('不正な bucket があっても他の正常 bucket は受理する(partial acceptance)', async () => {
  const { db, cleanup } = createTestDb()
  const result = await ingestObservation({
    db,
    observation: createObservation({
      buckets: [
        {
          bucketId: 'codex:primary',
          label: '5h',
          usedPercent: 28.5,
          remainingPercent: 71.5
        },
        {
          bucketId: 'codex:secondary',
          label: '7d',
          usedPercent: 150,
          remainingPercent: -50
        }
      ]
    }),
    tokenSourceId: 'dev-machine',
    now
  })

  expect(result.accepted).toEqual(['codex:primary'])
  expect(result.rejected.length).toBe(1)
  expect(result.rejected[0]?.index).toBe(1)
  const buckets = await statusBuckets(db)
  expect(buckets.length).toBe(1)
  expect(buckets[0]?.bucketId).toBe('codex:primary')
  cleanup()
})

test('bucket の未知フィールドは互換性のため無視して受理する', async () => {
  const { db, cleanup } = createTestDb()
  const result = await ingestObservation({
    db,
    observation: createObservation({
      buckets: [
        {
          bucketId: 'codex:primary',
          label: '5h',
          usedPercent: 28.5,
          remainingPercent: 71.5,
          vendorSpecificField: 'ignored'
        }
      ]
    }),
    tokenSourceId: 'dev-machine',
    now
  })
  expect(result.accepted).toEqual(['codex:primary'])
  expect(result.rejected).toEqual([])
  cleanup()
})

test('accountAlias が異なれば同じ bucketId でも別レコードとして保持する', async () => {
  const { db, cleanup } = createTestDb()
  await ingestObservation({
    db,
    observation: createObservation({ accountAlias: 'main' }),
    tokenSourceId: 'dev-machine',
    now
  })
  await ingestObservation({
    db,
    observation: createObservation({ accountAlias: 'sub' }),
    tokenSourceId: 'dev-machine',
    now
  })

  const status = await getStatus({ db, now })
  expect(
    status.accounts.map((account) => {
      return account.accountAlias
    })
  ).toEqual(['main', 'sub'])
  cleanup()
})

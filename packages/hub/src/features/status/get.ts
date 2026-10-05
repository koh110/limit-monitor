import { asc, eq } from 'drizzle-orm'
import { bucketIdSchema, SCHEMA_VERSION } from 'shared/src/contracts'
import { accountBucketOrders, latestLimits } from 'shared/src/db/schema'
import { computeFreshness } from 'shared/src/freshness'
import type * as schema from 'shared/src/schema'
import type { Db } from '../../lib/database.js'

type Provider = schema.components['schemas']['Provider']
type StatusAccount = schema.components['schemas']['StatusAccount']
type StatusBucket = schema.components['schemas']['StatusBucket']
type StatusResponse =
  schema.paths['/api/v1/status']['get']['responses']['200']['content']['application/json']

function parseBucketOrder(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    const bucketOrder: string[] = []
    for (const bucketId of parsed) {
      if (bucketIdSchema.safeParse(bucketId).success && !bucketOrder.includes(bucketId)) {
        bucketOrder.push(bucketId)
      }
    }
    return bucketOrder
  } catch {
    return []
  }
}

function orderBuckets(buckets: StatusBucket[], bucketOrder: string[]) {
  const bucketsById = new Map(
    buckets.map((bucket) => {
      return [bucket.bucketId, bucket] as const
    })
  )
  const orderedBuckets: StatusBucket[] = []
  const orderedIds = new Set<string>()
  for (const bucketId of bucketOrder) {
    const bucket = bucketsById.get(bucketId)
    if (bucket && !orderedIds.has(bucketId)) {
      orderedBuckets.push(bucket)
      orderedIds.add(bucketId)
    }
  }
  for (const bucket of buckets) {
    if (!orderedIds.has(bucket.bucketId)) {
      orderedBuckets.push(bucket)
      orderedIds.add(bucket.bucketId)
    }
  }
  return orderedBuckets
}

export async function getStatus({
  db,
  now,
  provider
}: {
  db: Db
  now: Date
  provider?: Provider
}): Promise<StatusResponse> {
  const query = db
    .select()
    .from(latestLimits)
    .orderBy(asc(latestLimits.provider), asc(latestLimits.accountAlias), asc(latestLimits.bucketId))
  const rows = provider ? await query.where(eq(latestLimits.provider, provider)) : await query
  const preferenceQuery = db.select().from(accountBucketOrders)
  const preferenceRows = provider
    ? await preferenceQuery.where(eq(accountBucketOrders.provider, provider))
    : await preferenceQuery
  const bucketOrders = new Map<string, string[]>()
  for (const row of preferenceRows) {
    bucketOrders.set(`${row.provider}\n${row.accountAlias}`, parseBucketOrder(row.bucketOrder))
  }

  const accounts = new Map<string, StatusAccount>()
  for (const row of rows) {
    const key = `${row.provider}\n${row.accountAlias}`
    let account = accounts.get(key)
    if (!account) {
      account = {
        // DB の provider 列は ingest 時に契約で検証済み
        provider: row.provider === 'claude' ? 'claude' : row.provider === 'grok' ? 'grok' : 'codex',
        accountAlias: row.accountAlias,
        buckets: []
      }
      accounts.set(key, account)
    }
    const freshness = computeFreshness(row.observedAt, now)
    account.buckets.push({
      bucketId: row.bucketId,
      label: row.label,
      usedPercent: row.usedPercent,
      remainingPercent: row.remainingPercent,
      windowDurationSeconds: row.windowDurationSeconds,
      resetsAt: row.resetsAt,
      observedAt: row.observedAt,
      reached: row.reached,
      // 行が存在する時点で観測済みのため never にはならない
      freshness: freshness === 'never' ? 'expired' : freshness
    } satisfies StatusBucket)
  }

  for (const [key, account] of accounts) {
    const bucketOrder = bucketOrders.get(key)
    if (bucketOrder) {
      account.buckets = orderBuckets(account.buckets, bucketOrder)
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    accounts: [...accounts.values()]
  }
}

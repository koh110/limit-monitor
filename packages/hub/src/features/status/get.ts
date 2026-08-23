import { asc, eq } from 'drizzle-orm'
import type { Provider, StatusAccount, StatusBucket, StatusResponse } from 'shared/src/contracts'
import { SCHEMA_VERSION } from 'shared/src/contracts'
import { latestLimits } from 'shared/src/db/schema'
import { computeFreshness } from 'shared/src/freshness'
import type { Db } from '../../lib/database.js'

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

  const accounts = new Map<string, StatusAccount>()
  for (const row of rows) {
    const key = `${row.provider}\n${row.accountAlias}`
    let account = accounts.get(key)
    if (!account) {
      account = {
        // DB の provider 列は ingest 時に契約で検証済み
        provider: row.provider === 'claude' ? 'claude' : 'codex',
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

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    accounts: [...accounts.values()]
  }
}

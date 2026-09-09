import { and, eq, inArray, sql } from 'drizzle-orm'
import type { ObservationBucket } from 'shared/src/contracts'
import { SCHEMA_VERSION, observationBucketSchema } from 'shared/src/contracts'
import { latestLimits } from 'shared/src/db/schema'
import type * as schema from 'shared/src/schema'
import { OBSERVED_AT_MAX_FUTURE_SKEW_MS, shouldReplaceLatest } from 'shared/src/selection'
import type { Db } from '../../lib/database.js'
import { createHttpException } from '../../lib/wrap.js'

type IngestApi = schema.paths['/api/v1/observations']['post']
type IngestResponse = IngestApi['responses']
type Observation = IngestApi['requestBody']['content']['application/json']
type IngestResult = IngestResponse['200']['content']['application/json']

export async function ingestObservation({
  db,
  observation,
  tokenSourceId,
  tokenAccountAlias,
  now
}: {
  db: Db
  observation: Observation
  tokenSourceId: string
  tokenAccountAlias: string
  now: Date
}): Promise<IngestResult> {
  // token は対応する sourceId だけを書き込める(仕様 7.2、mismatch は 403)
  if (observation.sourceId !== tokenSourceId) {
    throw createHttpException<IngestResponse['403']['content']['application/problem+json']>(403, {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: `token is not allowed to write for sourceId "${observation.sourceId}"`
    })
  }

  // accountAlias は認証 token 側が正。payload での明示は任意だが、
  // token と異なる accountAlias への書き込みは許可しない(403)
  if (observation.accountAlias !== undefined && observation.accountAlias !== tokenAccountAlias) {
    throw createHttpException<IngestResponse['403']['content']['application/problem+json']>(403, {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: `token is not allowed to write for accountAlias "${observation.accountAlias}"`
    })
  }
  const accountAlias = tokenAccountAlias

  // Hub 時刻より 5 分以上未来の観測は拒否する(仕様 6.3)
  if (Date.parse(observation.observedAt) - now.getTime() > OBSERVED_AT_MAX_FUTURE_SKEW_MS) {
    throw createHttpException<IngestResponse['400']['content']['application/problem+json']>(400, {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'observedAt is more than 5 minutes ahead of hub time'
    })
  }

  // bucket 単位の partial acceptance: 不正な bucket があっても他を破棄しない
  const rejected: IngestResult['rejected'] = []
  const bucketsById = new Map<string, ObservationBucket>()
  for (const [index, raw] of observation.buckets.entries()) {
    const parsed = observationBucketSchema.safeParse(raw)
    if (!parsed.success) {
      rejected.push({
        index,
        reason: parsed.error.issues
          .map((issue) => {
            return `${issue.path.join('.')}: ${issue.message}`
          })
          .join(', ')
      })
      continue
    }
    // 同一 payload 内の重複 bucketId は後勝ち
    bucketsById.set(parsed.data.bucketId, parsed.data)
  }

  const receivedAt = now.toISOString()
  const candidates = [...bucketsById.values()]

  const existingRows =
    candidates.length > 0
      ? await db
          .select({
            bucketId: latestLimits.bucketId,
            observedAt: latestLimits.observedAt,
            receivedAt: latestLimits.receivedAt
          })
          .from(latestLimits)
          .where(
            and(
              eq(latestLimits.provider, observation.provider),
              eq(latestLimits.accountAlias, accountAlias),
              inArray(
                latestLimits.bucketId,
                candidates.map((bucket) => {
                  return bucket.bucketId
                })
              )
            )
          )
      : []
  const existingByBucketId = new Map(
    existingRows.map((row) => {
      return [row.bucketId, row]
    })
  )

  const skipped: IngestResult['skipped'] = []
  const accepted: IngestResult['accepted'] = []
  const rowsToWrite: (typeof latestLimits.$inferInsert)[] = []
  for (const bucket of candidates) {
    const existing = existingByBucketId.get(bucket.bucketId)
    const incoming = { observedAt: observation.observedAt, receivedAt }
    // 古い観測の遅延到着は最新値を上書きしない(仕様 6.3)
    if (existing && !shouldReplaceLatest(existing, incoming)) {
      skipped.push({ bucketId: bucket.bucketId, reason: 'stale_observation' })
      continue
    }
    accepted.push(bucket.bucketId)
    rowsToWrite.push({
      provider: observation.provider,
      accountAlias,
      bucketId: bucket.bucketId,
      label: bucket.label,
      usedPercent: bucket.usedPercent,
      remainingPercent: bucket.remainingPercent,
      windowDurationSeconds: bucket.windowDurationSeconds ?? null,
      resetsAt: bucket.resetsAt ?? null,
      observedAt: observation.observedAt,
      receivedAt,
      sourceId: observation.sourceId,
      reached: bucket.reached ?? false
    })
  }

  if (rowsToWrite.length > 0) {
    await db
      .insert(latestLimits)
      .values(rowsToWrite)
      .onConflictDoUpdate({
        target: [latestLimits.provider, latestLimits.accountAlias, latestLimits.bucketId],
        set: {
          label: sql`excluded.label`,
          usedPercent: sql`excluded.used_percent`,
          remainingPercent: sql`excluded.remaining_percent`,
          windowDurationSeconds: sql`excluded.window_duration_seconds`,
          resetsAt: sql`excluded.resets_at`,
          observedAt: sql`excluded.observed_at`,
          receivedAt: sql`excluded.received_at`,
          sourceId: sql`excluded.source_id`,
          reached: sql`excluded.reached`
        }
      })
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    accepted,
    skipped,
    rejected
  }
}

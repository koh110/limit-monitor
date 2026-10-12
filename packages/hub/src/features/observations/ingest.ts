import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { ObservationBucket } from 'shared/src/contracts'
import { SCHEMA_VERSION, observationBucketSchema } from 'shared/src/contracts'
import { latestLimits, latestSnapshotMarkers } from 'shared/src/db/schema'
import type * as schema from 'shared/src/schema'
import { OBSERVED_AT_MAX_FUTURE_SKEW_MS, shouldReplaceLatest } from 'shared/src/selection'
import type { Db } from '../../lib/database.js'
import { createHttpException } from '../../lib/wrap.js'

type IngestApi = schema.paths['/api/v1/observations']['post']
type IngestResponse = IngestApi['responses']
type Observation = IngestApi['requestBody']['content']['application/json']
type IngestResult = IngestResponse['200']['content']['application/json']

function legacyClaudeWeekAlias(bucketId: string): string | null {
  const match = /^claude:week:(.+)-([0-9a-f]{32})$/.exec(bucketId)
  return match?.[1] ? `claude:week:${match[1]}` : null
}

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
  // sourceIdの基準は認証token。payloadのsourceIdは信用せず、tokenに
  // 紐付くsourceIdへ正規化する(collector側の設定名の不一致で403にしない)。
  const sourceId = tokenSourceId

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

  const candidates = [...bucketsById.values()]

  const receivedAt = now.toISOString()
  if (candidates.length === 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      accepted: [],
      skipped: [],
      rejected
    }
  }

  const legacyAliasesByBucketId = new Map(
    candidates.map((bucket) => [
      bucket.bucketId,
      observation.provider === 'claude' ? legacyClaudeWeekAlias(bucket.bucketId) : null
    ])
  )

  return db.transaction(
    (tx) => {
      const incoming = { observedAt: observation.observedAt, receivedAt }
      const [latestSnapshot] = tx
        .select({
          observedAt: latestSnapshotMarkers.observedAt,
          receivedAt: latestSnapshotMarkers.receivedAt
        })
        .from(latestSnapshotMarkers)
        .where(
          and(
            eq(latestSnapshotMarkers.provider, observation.provider),
            eq(latestSnapshotMarkers.accountAlias, accountAlias)
          )
        )
        .all()
      if (latestSnapshot && !shouldReplaceLatest(latestSnapshot, incoming)) {
        return {
          schemaVersion: SCHEMA_VERSION,
          accepted: [],
          skipped: candidates.map((bucket) => {
            return { bucketId: bucket.bucketId, reason: 'stale_observation' }
          }),
          rejected
        }
      }

      const existingRows = tx
        .select({
          bucketId: latestLimits.bucketId,
          observedAt: latestLimits.observedAt,
          receivedAt: latestLimits.receivedAt
        })
        .from(latestLimits)
        .where(
          and(
            eq(latestLimits.provider, observation.provider),
            eq(latestLimits.accountAlias, accountAlias)
          )
        )
        .all()
      const existingByBucketId = new Map(
        existingRows.map((row) => {
          return [row.bucketId, row]
        })
      )

      const skipped: IngestResult['skipped'] = []
      const accepted: IngestResult['accepted'] = []
      const acceptedBuckets: ObservationBucket[] = []
      const rowsToWrite: (typeof latestLimits.$inferInsert)[] = []
      for (const bucket of candidates) {
        const existing = existingByBucketId.get(bucket.bucketId)
        // 古い観測の遅延到着は最新値を上書きしない(仕様 6.3)
        if (existing && !shouldReplaceLatest(existing, incoming)) {
          skipped.push({ bucketId: bucket.bucketId, reason: 'stale_observation' })
          continue
        }
        accepted.push(bucket.bucketId)
        acceptedBuckets.push(bucket)
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
          sourceId,
          reached: bucket.reached ?? false
        })
      }

      const legacyBucketIdsToDelete = [
        ...new Set(
          acceptedBuckets.flatMap((bucket) => {
            const alias = legacyAliasesByBucketId.get(bucket.bucketId)
            if (!alias) return []
            const existingLegacy = existingByBucketId.get(alias)
            return !existingLegacy || shouldReplaceLatest(existingLegacy, incoming) ? [alias] : []
          })
        )
      ]
      if (legacyBucketIdsToDelete.length > 0) {
        tx.delete(latestLimits)
          .where(
            and(
              eq(latestLimits.provider, observation.provider),
              eq(latestLimits.accountAlias, accountAlias),
              inArray(latestLimits.bucketId, legacyBucketIdsToDelete)
            )
          )
          .run()
      }

      if (rowsToWrite.length > 0) {
        tx.insert(latestLimits)
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
          .run()
      }

      const isCompleteSnapshot =
        rejected.length === 0 && acceptedBuckets.length === candidates.length
      if (isCompleteSnapshot) {
        // 完全な snapshot に含まれない古い bucket は、同じ scope の stale 行として削除する。
        const currentBucketIds = new Set(candidates.map((bucket) => bucket.bucketId))
        const rowsToDelete = existingRows.filter((row) => {
          return !currentBucketIds.has(row.bucketId) && shouldReplaceLatest(row, incoming)
        })
        if (rowsToDelete.length > 0) {
          const deleteConditions = rowsToDelete.map((row) => {
            return and(
              eq(latestLimits.bucketId, row.bucketId),
              eq(latestLimits.observedAt, row.observedAt),
              eq(latestLimits.receivedAt, row.receivedAt)
            )
          })
          tx.delete(latestLimits)
            .where(
              and(
                eq(latestLimits.provider, observation.provider),
                eq(latestLimits.accountAlias, accountAlias),
                or(...deleteConditions)
              )
            )
            .run()
        }
        tx.insert(latestSnapshotMarkers)
          .values({
            provider: observation.provider,
            accountAlias,
            observedAt: observation.observedAt,
            receivedAt
          })
          .onConflictDoUpdate({
            target: [latestSnapshotMarkers.provider, latestSnapshotMarkers.accountAlias],
            set: {
              observedAt: sql`excluded.observed_at`,
              receivedAt: sql`excluded.received_at`
            }
          })
          .run()
      }

      return {
        schemaVersion: SCHEMA_VERSION,
        accepted,
        skipped,
        rejected
      }
    },
    { behavior: 'immediate' }
  )
}

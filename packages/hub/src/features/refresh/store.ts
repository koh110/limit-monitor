import { randomUUID } from 'node:crypto'
import { and, eq, inArray, lt, or } from 'drizzle-orm'
import { refreshRequests } from 'shared/src/db/schema'
import type { Provider } from 'shared/src/contracts'
import type { RefreshStatus } from 'shared/src/control'
import type { Db } from '../../lib/database.js'

type RefreshLifecycleStatus = Extract<RefreshStatus, 'running' | 'completed' | 'failed'>

export const REFRESH_LEASE_TIMEOUT_MS = 10 * 60 * 1000
// Agent が長時間 offline のままになった queued request は単発要求として
// 24 時間で破棄し、同じ scope の新しい要求を永久に coalesce しない。
export const REFRESH_QUEUED_RETENTION_MS = 24 * 60 * 60 * 1000

export async function enqueueRefresh({
  db,
  provider,
  accountAlias,
  sourceId,
  now
}: {
  db: Db
  provider: Provider
  accountAlias: string
  sourceId: string
  now: Date
}) {
  const existing = await findActiveRefresh({ db, provider, accountAlias, sourceId })
  if (existing) return existing
  const id = randomUUID()

  try {
    await db.insert(refreshRequests).values({
      id,
      provider,
      accountAlias,
      sourceId,
      requestedAt: now.toISOString(),
      status: 'queued',
      leaseId: null,
      dispatchedAt: null,
      startedAt: null,
      completedAt: null,
      errorCode: null
    })
    return { id, status: 'queued' as const }
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const concurrent = await findActiveRefresh({ db, provider, accountAlias, sourceId })
    if (!concurrent) throw error
    return concurrent
  }
}

function isUniqueConstraintError(error: unknown) {
  if (!(error instanceof Error)) return false
  if (error.message.includes('UNIQUE constraint failed: refresh_requests')) return true
  const cause = error.cause
  return typeof cause === 'object' && cause !== null && 'errcode' in cause && cause.errcode === 2067
}

async function findActiveRefresh({
  db,
  provider,
  accountAlias,
  sourceId
}: {
  db: Db
  provider: Provider
  accountAlias: string
  sourceId: string
}) {
  const rows = await db
    .select({ id: refreshRequests.id, status: refreshRequests.status })
    .from(refreshRequests)
    .where(
      and(
        eq(refreshRequests.provider, provider),
        eq(refreshRequests.accountAlias, accountAlias),
        eq(refreshRequests.sourceId, sourceId),
        inArray(refreshRequests.status, ['queued', 'dispatched', 'running'])
      )
    )
    .limit(1)
  return rows[0]
}

export async function getRefresh({ db, id }: { db: Db; id: string }) {
  const rows = await db.select().from(refreshRequests).where(eq(refreshRequests.id, id)).limit(1)
  return rows[0] ?? null
}

export async function updateRefreshStatus({
  db,
  id,
  leaseId,
  status,
  now,
  errorCode
}: {
  db: Db
  id: string
  leaseId: string
  status: RefreshLifecycleStatus
  now: Date
  errorCode?: string
}) {
  const stamp = now.toISOString()
  const values =
    status === 'running'
      ? { status, startedAt: stamp }
      : { status, leaseId: null, completedAt: stamp, errorCode: errorCode ?? null }
  const acceptedStatuses = status === 'running' ? ['dispatched'] : ['dispatched', 'running']
  await db
    .update(refreshRequests)
    .set(values)
    .where(
      and(
        eq(refreshRequests.id, id),
        eq(refreshRequests.leaseId, leaseId),
        inArray(refreshRequests.status, acceptedStatuses)
      )
    )
}

export async function listQueuedRefreshes({
  db,
  sourceId,
  accountAlias
}: {
  db: Db
  sourceId: string
  accountAlias: string
}) {
  return db
    .select()
    .from(refreshRequests)
    .where(
      and(
        eq(refreshRequests.status, 'queued'),
        eq(refreshRequests.sourceId, sourceId),
        eq(refreshRequests.accountAlias, accountAlias)
      )
    )
}

export async function claimQueuedRefresh({ db, id, now }: { db: Db; id: string; now: Date }) {
  const dispatchedAt = now.toISOString()
  const leaseId = randomUUID()
  const rows = await db
    .update(refreshRequests)
    .set({ status: 'dispatched', dispatchedAt, leaseId })
    .where(and(eq(refreshRequests.id, id), eq(refreshRequests.status, 'queued')))
    .returning({ id: refreshRequests.id, leaseId: refreshRequests.leaseId })
  const row = rows[0]
  if (!row || !row.leaseId) return null
  return { id: row.id, dispatchedAt, leaseId: row.leaseId }
}

export async function releaseRefreshDispatch({
  db,
  id,
  dispatchedAt,
  leaseId
}: {
  db: Db
  id: string
  dispatchedAt: string
  leaseId: string
}) {
  await db
    .update(refreshRequests)
    .set({ status: 'queued', dispatchedAt: null, leaseId: null, startedAt: null, errorCode: null })
    .where(
      and(
        eq(refreshRequests.id, id),
        eq(refreshRequests.status, 'dispatched'),
        eq(refreshRequests.dispatchedAt, dispatchedAt),
        eq(refreshRequests.leaseId, leaseId)
      )
    )
}

/**
 * Agent crash / disconnect後に期限切れのleaseをdurable queueへ戻す。
 * 定期lease schedulerまたは次の接続時に通常のqueued dispatchへ収束させる。
 * 行ごとのUPDATEは行わず、scopeを跨いだ一括UPDATEにする。
 */
export async function requeueExpiredRefreshes({
  db,
  now = new Date(),
  leaseTimeoutMs = REFRESH_LEASE_TIMEOUT_MS,
  queuedRetentionMs = REFRESH_QUEUED_RETENTION_MS
}: {
  db: Db
  now?: Date
  leaseTimeoutMs?: number
  queuedRetentionMs?: number
}) {
  const leaseBefore = new Date(now.getTime() - leaseTimeoutMs).toISOString()
  const queuedBefore = new Date(now.getTime() - queuedRetentionMs).toISOString()
  await db
    .delete(refreshRequests)
    .where(and(eq(refreshRequests.status, 'queued'), lt(refreshRequests.requestedAt, queuedBefore)))
  await db
    .update(refreshRequests)
    .set({
      status: 'queued',
      dispatchedAt: null,
      leaseId: null,
      startedAt: null,
      errorCode: null
    })
    .where(
      or(
        and(
          eq(refreshRequests.status, 'dispatched'),
          lt(refreshRequests.dispatchedAt, leaseBefore)
        ),
        and(eq(refreshRequests.status, 'running'), lt(refreshRequests.startedAt, leaseBefore))
      )
    )
}

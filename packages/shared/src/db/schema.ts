import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'

export const latestLimits = sqliteTable(
  'latest_limits',
  {
    provider: text('provider').notNull(),
    accountAlias: text('account_alias').notNull(),
    bucketId: text('bucket_id').notNull(),
    label: text('label').notNull(),
    usedPercent: real('used_percent').notNull(),
    remainingPercent: real('remaining_percent').notNull(),
    windowDurationSeconds: integer('window_duration_seconds'),
    resetsAt: text('resets_at'),
    observedAt: text('observed_at').notNull(),
    receivedAt: text('received_at').notNull(),
    sourceId: text('source_id').notNull(),
    // ベンダーが返す「limit 到達」フラグ。到達した/していないの本質的な 2 値であり
    // 第 3 の状態が存在しないため boolean(INTEGER 0/1)を許容する(仕様 8.1 準拠)
    reached: integer('reached', { mode: 'boolean' }).notNull().default(false)
  },
  (table) => {
    return [primaryKey({ columns: [table.provider, table.accountAlias, table.bucketId] })]
  }
)

// token は sourceId + accountAlias の組に紐づく。1 つの sourceId が複数の
// accountAlias(= 複数アカウント)の token を持てる(仕様 7.2)
export const collectorTokens = sqliteTable(
  'collector_tokens',
  {
    sourceId: text('source_id').notNull(),
    accountAlias: text('account_alias').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: text('created_at').notNull(),
    revokedAt: text('revoked_at')
  },
  (table) => {
    return [primaryKey({ columns: [table.sourceId, table.accountAlias] })]
  }
)

export const refreshRequests = sqliteTable(
  'refresh_requests',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    accountAlias: text('account_alias').notNull(),
    sourceId: text('source_id').notNull(),
    requestedAt: text('requested_at').notNull(),
    dispatchedAt: text('dispatched_at'),
    leaseId: text('lease_id'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    status: text('status').notNull(),
    errorCode: text('error_code')
  },
  (table) => {
    return [
      index('refresh_requests_scope_status_idx').on(
        table.sourceId,
        table.provider,
        table.accountAlias,
        table.status
      ),
      index('refresh_requests_lease_idx').on(table.status, table.dispatchedAt, table.startedAt),
      uniqueIndex('refresh_requests_active_scope_idx')
        .on(table.sourceId, table.provider, table.accountAlias)
        .where(sql`${table.status} in ('queued', 'dispatched', 'running')`)
    ]
  }
)

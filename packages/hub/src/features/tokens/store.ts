import { createHash, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { collectorTokens } from 'shared/src/db/schema'
import type { Db } from '../../lib/database.js'

// token は平文保存せず hash のみを保存する(仕様 7.2)
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * sourceId + accountAlias の組に対する token を発行する。既存 token がある場合は
 * 新しい token で置き換える(再発行)。平文 token はこの戻り値でのみ得られる。
 * 同一 sourceId でも accountAlias が異なれば別 token として共存する。
 */
export async function issueToken({
  db,
  sourceId,
  accountAlias,
  now
}: {
  db: Db
  sourceId: string
  accountAlias: string
  now: Date
}) {
  const token = `lmt_${randomBytes(32).toString('base64url')}`
  const tokenHash = hashToken(token)
  const createdAt = now.toISOString()
  await db
    .insert(collectorTokens)
    .values({ sourceId, accountAlias, tokenHash, createdAt, revokedAt: null })
    .onConflictDoUpdate({
      target: [collectorTokens.sourceId, collectorTokens.accountAlias],
      set: { tokenHash, createdAt, revokedAt: null }
    })
  return { sourceId, accountAlias, token }
}

export async function revokeToken({
  db,
  sourceId,
  accountAlias,
  now
}: {
  db: Db
  sourceId: string
  accountAlias: string
  now: Date
}) {
  const rows = await db
    .update(collectorTokens)
    .set({ revokedAt: now.toISOString() })
    .where(
      and(eq(collectorTokens.sourceId, sourceId), eq(collectorTokens.accountAlias, accountAlias))
    )
    .returning({ sourceId: collectorTokens.sourceId })
  return rows.length > 0
}

export async function listTokens({ db }: { db: Db }) {
  // token hash は一覧に含めない
  return await db
    .select({
      sourceId: collectorTokens.sourceId,
      accountAlias: collectorTokens.accountAlias,
      createdAt: collectorTokens.createdAt,
      revokedAt: collectorTokens.revokedAt
    })
    .from(collectorTokens)
    .orderBy(collectorTokens.sourceId, collectorTokens.accountAlias)
}

/**
 * Bearer token を検証し、有効なら書き込みを許可する sourceId と accountAlias を返す。
 * 未登録・失効はいずれも null(認証失敗は 401 に丸める。仕様 7.2)
 */
export async function verifyToken({ db, token }: { db: Db; token: string }) {
  const rows = await db
    .select({
      sourceId: collectorTokens.sourceId,
      accountAlias: collectorTokens.accountAlias,
      revokedAt: collectorTokens.revokedAt
    })
    .from(collectorTokens)
    .where(eq(collectorTokens.tokenHash, hashToken(token)))
    .limit(1)
  const row = rows[0]
  if (!row || row.revokedAt !== null) {
    return null
  }
  return { sourceId: row.sourceId, accountAlias: row.accountAlias }
}

import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { collectorTokens } from 'shared/src/db/schema'
import type { Db } from '../../lib/database.js'

// token は平文保存せず hash のみを保存する(仕様 7.2)
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * sourceId に対する token を発行する。既存 token がある場合は新しい token で
 * 置き換える(再発行)。平文 token はこの戻り値でのみ得られる。
 */
export async function issueToken({ db, sourceId, now }: { db: Db; sourceId: string; now: Date }) {
  const token = `lmt_${randomBytes(32).toString('base64url')}`
  const tokenHash = hashToken(token)
  const createdAt = now.toISOString()
  await db
    .insert(collectorTokens)
    .values({ sourceId, tokenHash, createdAt, revokedAt: null })
    .onConflictDoUpdate({
      target: collectorTokens.sourceId,
      set: { tokenHash, createdAt, revokedAt: null }
    })
  return { sourceId, token }
}

export async function revokeToken({ db, sourceId, now }: { db: Db; sourceId: string; now: Date }) {
  const rows = await db
    .update(collectorTokens)
    .set({ revokedAt: now.toISOString() })
    .where(eq(collectorTokens.sourceId, sourceId))
    .returning({ sourceId: collectorTokens.sourceId })
  return rows.length > 0
}

export async function listTokens({ db }: { db: Db }) {
  // token hash は一覧に含めない
  return await db
    .select({
      sourceId: collectorTokens.sourceId,
      createdAt: collectorTokens.createdAt,
      revokedAt: collectorTokens.revokedAt
    })
    .from(collectorTokens)
    .orderBy(collectorTokens.sourceId)
}

/**
 * Bearer token を検証し、有効なら書き込みを許可する sourceId を返す。
 * 未登録・失効はいずれも null(認証失敗は 401 に丸める。仕様 7.2)
 */
export async function verifyToken({ db, token }: { db: Db; token: string }) {
  const rows = await db
    .select({
      sourceId: collectorTokens.sourceId,
      revokedAt: collectorTokens.revokedAt
    })
    .from(collectorTokens)
    .where(eq(collectorTokens.tokenHash, hashToken(token)))
    .limit(1)
  const row = rows[0]
  if (!row || row.revokedAt !== null) {
    return null
  }
  return { sourceId: row.sourceId }
}

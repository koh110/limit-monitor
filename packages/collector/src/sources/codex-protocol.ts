import * as z from 'zod/mini'
import type { CodexRateLimitsPayload } from '../adapters/codex.js'

/**
 * Codex CLI の app-server(`codex app-server`)は stdio 上の JSON-RPC 2.0 風
 * protocol を話す。rate limit の正式な非対話取得経路は
 * `account/rateLimits/read` request である
 * (`codex app-server generate-json-schema` の ClientRequest に定義がある)。
 *
 * handshake:
 *   1. `initialize` request(id 付き)を送る
 *   2. 応答後に `initialized` notification を送る
 *   3. `account/rateLimits/read`(params: null)を送る
 *
 * `configWarning` / `remoteControl/status/changed` などの notification が
 * 割り込むため、応答は必ず id で突き合わせる。
 */
export const CODEX_INITIALIZE_ID = 1 as const
export const CODEX_RATE_LIMITS_ID = 2 as const

export const CODEX_APP_SERVER_ARGS = ['app-server'] as const

export function buildCodexInitializeRequest({
  clientName,
  clientVersion
}: {
  clientName: string
  clientVersion: string
}): string {
  return JSON.stringify({
    id: CODEX_INITIALIZE_ID,
    method: 'initialize',
    params: { clientInfo: { name: clientName, version: clientVersion } }
  })
}

export function buildCodexInitializedNotification(): string {
  return JSON.stringify({ method: 'initialized' })
}

export function buildCodexRateLimitsRequest(): string {
  return JSON.stringify({
    id: CODEX_RATE_LIMITS_ID,
    method: 'account/rateLimits/read',
    params: null
  })
}

// JSON-RPC の error message は vendor の応答本文ではなく protocol の
// エラー文言なので、原因調査のため長さを切って保持する
const ERROR_MESSAGE_MAX_LENGTH = 200

export type CodexMessage =
  | { kind: 'result'; id: number; result: unknown }
  | { kind: 'error'; id: number; code: number | null; message: string }
  | { kind: 'other' }

const messageSchema = z.object({
  id: z.optional(z.nullable(z.union([z.number(), z.string()]))),
  result: z.optional(z.unknown()),
  error: z.optional(
    z.nullable(
      z.object({
        code: z.optional(z.nullable(z.number())),
        message: z.optional(z.nullable(z.string()))
      })
    )
  )
})

/** app-server の 1 行を分類する。id を持たない notification は 'other' に落とす */
export function parseCodexMessage(line: string): CodexMessage {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { kind: 'other' }
  }
  const parsed = messageSchema.safeParse(raw)
  if (!parsed.success || typeof parsed.data.id !== 'number') {
    return { kind: 'other' }
  }
  const id = parsed.data.id
  const error = parsed.data.error
  if (error) {
    return {
      kind: 'error',
      id,
      code: error.code ?? null,
      message: (error.message ?? 'unknown app-server error').slice(0, ERROR_MESSAGE_MAX_LENGTH)
    }
  }
  if ('result' in parsed.data) {
    return { kind: 'result', id, result: parsed.data.result }
  }
  return { kind: 'other' }
}

// 応答のうち収集に使うフィールドだけを宣言する。zod object は未知 key を
// 落とすため、credits / planType / individualLimit 等は Hub へ渡らない
const windowSchema = z.object({
  usedPercent: z.optional(z.nullable(z.number())),
  windowDurationMins: z.optional(z.nullable(z.number())),
  resetsAt: z.optional(z.nullable(z.union([z.string(), z.number()])))
})

const limitSchema = z.object({
  limitId: z.string(),
  limitName: z.optional(z.nullable(z.string())),
  primary: z.optional(z.nullable(windowSchema)),
  secondary: z.optional(z.nullable(windowSchema)),
  rateLimitReachedType: z.optional(z.nullable(z.string()))
})

const rateLimitsResultSchema = z.object({
  rateLimits: z.optional(z.nullable(limitSchema)),
  rateLimitsByLimitId: z.optional(z.nullable(z.record(z.string(), limitSchema)))
})

export type CodexRateLimitsResultParse =
  | { ok: true; payload: CodexRateLimitsPayload }
  | { ok: false; reason: 'unexpected_shape' | 'no_rate_limits'; detail: string }

/** `account/rateLimits/read` の result を検証して adapter へ渡せる形にする */
export function parseCodexRateLimitsResult(result: unknown): CodexRateLimitsResultParse {
  const parsed = rateLimitsResultSchema.safeParse(result)
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'unexpected_shape',
      detail: 'unexpected account/rateLimits/read result shape'
    }
  }
  const { rateLimits, rateLimitsByLimitId } = parsed.data
  const hasByLimitId = rateLimitsByLimitId && Object.keys(rateLimitsByLimitId).length > 0
  if (!hasByLimitId && !rateLimits) {
    return {
      ok: false,
      reason: 'no_rate_limits',
      detail: 'account/rateLimits/read returned no rate limits'
    }
  }
  return {
    ok: true,
    payload: {
      rateLimits: rateLimits ?? null,
      rateLimitsByLimitId: rateLimitsByLimitId ?? null
    }
  }
}

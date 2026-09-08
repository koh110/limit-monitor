import type { Observation } from 'shared/src/contracts'
import { calcRemainingPercent } from 'shared/src/remaining'
import { normalizeEpochOrIso } from '../lib/normalize-time.js'

/**
 * Codex app-server `account/rateLimits/read` の応答のうち、collector が利用する
 * フィールドだけを表す型。CLI version 差はこの adapter 内へ閉じ込める。
 */
export type CodexRateLimitWindow = {
  // 実測の app-server 応答では常に数値だが、欠落した window を捨てられるよう
  // optional として受け取り、非数値は bucket を作らない
  usedPercent?: number | null
  windowDurationMins?: number | null
  // 実測の `account/rateLimits/read` は unix 秒(例: 1788274954)を返す。
  // CLI version 差で ISO 文字列の場合もあるため両方を受ける
  resetsAt?: string | number | null
}

export type CodexRateLimit = {
  limitId: string
  limitName?: string | null
  primary?: CodexRateLimitWindow | null
  secondary?: CodexRateLimitWindow | null
  rateLimitReachedType?: string | null
}

export type CodexRateLimitsPayload = {
  rateLimits?: CodexRateLimit | null
  rateLimitsByLimitId?: Record<string, CodexRateLimit> | null
}

// windowDurationMins から UI ラベルを生成する(primary/secondary という名前を
// UI の意味として固定しない。仕様 5.1)
function windowLabel(mins: number | null | undefined, fallback: string): string {
  if (!mins || mins <= 0) {
    return fallback
  }
  if (mins % 1440 === 0) {
    return `${mins / 1440}d`
  }
  if (mins % 60 === 0) {
    return `${mins / 60}h`
  }
  return `${mins}m`
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/**
 * Codex の rateLimits payload を正規化 Observation へ変換する。
 * rateLimitsByLimitId があれば固定 1 枠ではなく全 bucket を扱う。
 * 有効な bucket が 1 件もなければ null(送信しない)。
 */
export function buildCodexObservation({
  payload,
  sourceId,
  observedAt
}: {
  payload: CodexRateLimitsPayload
  sourceId: string
  observedAt: string
}): Observation | null {
  const limits = payload.rateLimitsByLimitId
    ? Object.values(payload.rateLimitsByLimitId)
    : payload.rateLimits
      ? [payload.rateLimits]
      : []

  const buckets = limits.flatMap((limit) => {
    const windows = [
      ['primary', limit.primary],
      ['secondary', limit.secondary]
    ] as const
    return windows
      .filter(([, window]) => {
        return window != null
      })
      .map(([key, window]) => {
        // filter 済みだが型を絞るため再チェックする
        if (window == null || typeof window.usedPercent !== 'number') {
          return null
        }
        const usedPercent = clampPercent(window.usedPercent)
        return {
          bucketId: `codex:${limit.limitId}:${key}`,
          label: windowLabel(window.windowDurationMins, key),
          usedPercent,
          remainingPercent: calcRemainingPercent(usedPercent),
          windowDurationSeconds: window.windowDurationMins ? window.windowDurationMins * 60 : null,
          resetsAt: normalizeEpochOrIso(window.resetsAt),
          reached: usedPercent >= 100
        }
      })
      .filter((bucket) => {
        return bucket !== null
      })
  })

  if (buckets.length === 0) {
    return null
  }

  // accountAlias は送らない。Hub が認証 token の accountAlias で正規化する
  return {
    schemaVersion: 1,
    provider: 'codex',
    sourceId,
    observedAt,
    buckets
  }
}

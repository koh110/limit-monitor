import type { Observation } from 'shared/src/contracts'
import { calcRemainingPercent } from 'shared/src/remaining'

/**
 * Claude Code statusLine JSON のうち、collector が利用するフィールドだけを表す型。
 * transcript_path / cwd / session ID 等は読み取らない(仕様 5.2)。
 */
export type ClaudeRateLimitWindow = {
  used_percentage?: number | null
  resets_at?: string | number | null
}

export type ClaudeStatusLineInput = {
  rate_limits?: {
    five_hour?: ClaudeRateLimitWindow | null
    seven_day?: ClaudeRateLimitWindow | null
  } | null
}

const CLAUDE_WINDOWS = [
  { key: 'five_hour', label: '5h', windowDurationSeconds: 5 * 60 * 60 },
  { key: 'seven_day', label: '7d', windowDurationSeconds: 7 * 24 * 60 * 60 }
] as const

// resets_at は CLI version により unix 秒または ISO 文字列で渡される
function normalizeResetsAt(resetsAt: string | number | null | undefined): string | null {
  if (resetsAt == null) {
    return null
  }
  if (typeof resetsAt === 'number') {
    return new Date(resetsAt * 1000).toISOString()
  }
  return resetsAt
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/**
 * Claude statusLine JSON を正規化 Observation へ変換する。
 * rate_limits が欠落した呼び出しでは null を返し、何も送信しない
 * (Hub 側の以前の有効値を消さない。仕様 5.2)。
 * five_hour / seven_day は片方だけ存在してもよい。
 */
export function buildClaudeObservation({
  statusLine,
  accountAlias,
  sourceId,
  observedAt
}: {
  statusLine: ClaudeStatusLineInput
  accountAlias: string
  sourceId: string
  observedAt: string
}): Observation | null {
  const rateLimits = statusLine.rate_limits
  if (rateLimits == null) {
    return null
  }

  const buckets = CLAUDE_WINDOWS.map((window) => {
    const raw = rateLimits[window.key]
    if (raw == null || typeof raw.used_percentage !== 'number') {
      return null
    }
    const usedPercent = clampPercent(raw.used_percentage)
    return {
      bucketId: `claude:${window.key}`,
      label: window.label,
      usedPercent,
      remainingPercent: calcRemainingPercent(usedPercent),
      windowDurationSeconds: window.windowDurationSeconds,
      resetsAt: normalizeResetsAt(raw.resets_at),
      reached: usedPercent >= 100
    }
  }).filter((bucket) => {
    return bucket !== null
  })

  if (buckets.length === 0) {
    return null
  }

  return {
    schemaVersion: 1,
    provider: 'claude',
    accountAlias,
    sourceId,
    observedAt,
    buckets
  }
}

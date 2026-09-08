import type { Observation } from 'shared/src/contracts'
import { calcRemainingPercent } from 'shared/src/remaining'
import { normalizeEpochOrIso } from '../lib/normalize-time.js'

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
  sourceId,
  observedAt
}: {
  statusLine: ClaudeStatusLineInput
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
      resetsAt: normalizeEpochOrIso(raw.resets_at),
      reached: usedPercent >= 100
    }
  }).filter((bucket) => {
    return bucket !== null
  })

  if (buckets.length === 0) {
    return null
  }

  // accountAlias は送らない。Hub が認証 token の accountAlias で正規化する
  return {
    schemaVersion: 1,
    provider: 'claude',
    sourceId,
    observedAt,
    buckets
  }
}

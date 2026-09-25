import type { Observation } from 'shared/src/contracts'
import { calcRemainingPercent } from 'shared/src/remaining'

export type GrokUsagePeriod = {
  type?: string | null
  start?: string | null
  end?: string | null
}

export type GrokCent = {
  val?: number | null
}

export type GrokBillingConfig = {
  creditUsagePercent?: number | null
  currentPeriod?: GrokUsagePeriod | null
  monthlyLimit?: GrokCent | null
  used?: GrokCent | null
  billingPeriodStart?: string | null
  billingPeriodEnd?: string | null
}

export type GrokBillingResponse = {
  config?: GrokBillingConfig | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function readLegacyPercent(config: Record<string, unknown>): number | null {
  const limit = isRecord(config.monthlyLimit) ? finiteNumber(config.monthlyLimit.val) : null
  const used = isRecord(config.used) ? finiteNumber(config.used.val) : null
  if (limit === null || used === null || limit === 0) {
    return null
  }
  return clampPercent((Math.abs(used) / Math.abs(limit)) * 100)
}

function readUsagePercent(
  config: Record<string, unknown>,
  period: { id: string; resetsAt: string | null }
): number | null {
  const currentPercent = finiteNumber(config.creditUsagePercent)
  if (currentPercent !== null) {
    // 現行ACPのcreditUsagePercentはGrok UIの使用済み率として返る。
    return clampPercent(currentPercent)
  }
  const legacyUsedPercent = readLegacyPercent(config)
  if (legacyUsedPercent !== null) {
    return legacyUsedPercent
  }
  // unified billing は利用開始直後などに creditUsagePercent を省略するが、
  // currentPeriod は返す。この場合は新しい期間の未使用状態として扱い、
  // reset 時刻だけでなく最新の使用率も更新できるようにする。
  if (
    config.isUnifiedBillingUser === true &&
    (period.id === 'weekly' || period.id === 'monthly') &&
    period.resetsAt !== null
  ) {
    return 0
  }
  return null
}

function periodInfo(config: Record<string, unknown>): {
  id: string
  label: string
  resetsAt: string | null
  windowDurationSeconds: number | null
} {
  const currentPeriod = isRecord(config.currentPeriod) ? config.currentPeriod : null
  const periodType =
    currentPeriod && typeof currentPeriod.type === 'string' ? currentPeriod.type : null
  const start = normalizeIso(currentPeriod?.start ?? config.billingPeriodStart)
  const end = normalizeIso(currentPeriod?.end ?? config.billingPeriodEnd)

  let id = 'usage'
  let label = 'Usage'
  if (periodType?.includes('WEEKLY')) {
    id = 'weekly'
    label = 'Weekly'
  } else if (periodType?.includes('MONTHLY') || (!currentPeriod && end)) {
    id = 'monthly'
    label = 'Monthly'
  }

  let windowDurationSeconds: number | null = null
  if (start && end) {
    const durationMs = new Date(end).getTime() - new Date(start).getTime()
    if (durationMs > 0) {
      windowDurationSeconds = Math.floor(durationMs / 1000)
    }
  }

  return { id, label, resetsAt: end, windowDurationSeconds }
}

/**
 * Grok Build ACP の `x.ai/billing` 応答を正規化 Observation へ変換する。
 * 現行の `creditUsagePercent` を優先し、旧 CLI の monthlyLimit/used にも fallback する。
 */
export function buildGrokObservation({
  payload,
  sourceId,
  observedAt
}: {
  payload: unknown
  sourceId: string
  observedAt: string
}): Observation | null {
  if (!isRecord(payload) || !isRecord(payload.config)) {
    return null
  }
  const config = payload.config
  const period = periodInfo(config)
  const usedPercent = readUsagePercent(config, period)
  if (usedPercent === null) {
    return null
  }
  const remainingPercent = calcRemainingPercent(usedPercent)

  return {
    schemaVersion: 1,
    provider: 'grok',
    sourceId,
    observedAt,
    buckets: [
      {
        bucketId: `grok:${period.id}`,
        label: period.label,
        usedPercent,
        remainingPercent,
        windowDurationSeconds: period.windowDurationSeconds,
        resetsAt: period.resetsAt,
        reached: usedPercent >= 100
      }
    ]
  }
}

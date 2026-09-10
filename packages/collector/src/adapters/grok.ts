import type { Observation } from 'shared/src/contracts'
import { calcRemainingPercent } from 'shared/src/remaining'

export type GrokBillingConfig = {
  creditUsagePercent?: number | null
  currentPeriod?: {
    type?: string | null
    start?: string | null
    end?: string | null
  } | null
  billingPeriodStart?: string | null
  billingPeriodEnd?: string | null
}

export type GrokBillingContext = {
  config?: GrokBillingConfig | null
}

type GrokUnifiedLogLine = {
  ctx?: GrokBillingContext | null
}

const BILLING_MESSAGE = 'billing: fetched credits config'

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null
  }
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function periodLabel(type: string | null | undefined): string {
  if (type?.includes('WEEKLY')) {
    return '7d'
  }
  if (type?.includes('MONTHLY')) {
    return 'monthly'
  }
  return 'usage'
}

export function parseGrokBillingLine(line: string): GrokBillingContext | null {
  // unified logger の message field 名に依存せず、billing event の識別文字列と
  // 構造化 ctx の両方を確認する。ログ format の周辺 metadata 変更に耐えるため。
  if (!line.includes(BILLING_MESSAGE)) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (parsed == null || typeof parsed !== 'object') {
    return null
  }
  const value = parsed as GrokUnifiedLogLine
  if (value.ctx == null || typeof value.ctx !== 'object') {
    return null
  }
  return value.ctx
}

/** Grok Build の billing credits config を共通 Observation に正規化する。 */
export function buildGrokObservation({
  billing,
  sourceId,
  observedAt
}: {
  billing: GrokBillingContext
  sourceId: string
  observedAt: string
}): Observation | null {
  const config = billing.config
  if (config == null || typeof config.creditUsagePercent !== 'number') {
    return null
  }

  const usedPercent = clampPercent(config.creditUsagePercent)
  const start = validIso(config.currentPeriod?.start ?? config.billingPeriodStart)
  const end = validIso(config.currentPeriod?.end ?? config.billingPeriodEnd)
  const durationSeconds =
    start && end ? Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 1000)) : null

  return {
    schemaVersion: 1,
    provider: 'grok',
    sourceId,
    observedAt,
    buckets: [
      {
        bucketId: 'grok:credits',
        label: periodLabel(config.currentPeriod?.type),
        usedPercent,
        remainingPercent: calcRemainingPercent(usedPercent),
        windowDurationSeconds: durationSeconds,
        resetsAt: end,
        reached: usedPercent >= 100
      }
    ]
  }
}

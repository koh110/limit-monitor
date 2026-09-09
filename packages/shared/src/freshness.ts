export const FRESHNESS_THRESHOLDS = {
  // 最終観測から 10 分未満は fresh
  staleAfterMs: 10 * 60 * 1000,
  // 10 分以上 24 時間未満は stale、それ以上は expired
  expiredAfterMs: 24 * 60 * 60 * 1000
} as const

export type Freshness = 'fresh' | 'stale' | 'expired' | 'never'

export function computeFreshness(observedAt: string | null, now: Date): Freshness {
  if (observedAt === null) {
    return 'never'
  }
  const observedMs = Date.parse(observedAt)
  if (Number.isNaN(observedMs)) {
    return 'never'
  }
  // clock skew で観測時刻が未来になっても fresh として扱う
  const ageMs = Math.max(0, now.getTime() - observedMs)
  if (ageMs < FRESHNESS_THRESHOLDS.staleAfterMs) {
    return 'fresh'
  }
  if (ageMs < FRESHNESS_THRESHOLDS.expiredAfterMs) {
    return 'stale'
  }
  return 'expired'
}

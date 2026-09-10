// vendor が返す reset 時刻の妥当範囲。unix 秒/ミリ秒の誤読や壊れた値を弾く
const MIN_EPOCH_MS = Date.UTC(2000, 0, 1)
const MAX_EPOCH_MS = Date.UTC(2100, 0, 1)

/**
 * vendor の reset 時刻(unix 秒 または 日時文字列)を Hub 契約の
 * ISO 8601(UTC)へ正規化する。解釈できない値は null にして bucket 自体は残す
 * (reset 時刻が読めないだけで使用率の観測を捨てない)。
 */
export function normalizeEpochOrIso(value: string | number | null | undefined): string | null {
  if (value == null) {
    return null
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null
    }
    return toIsoInRange(value * 1000)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  return toIsoInRange(Date.parse(trimmed))
}

function toIsoInRange(epochMs: number): string | null {
  if (!Number.isFinite(epochMs) || epochMs < MIN_EPOCH_MS || epochMs >= MAX_EPOCH_MS) {
    return null
  }
  return new Date(epochMs).toISOString()
}

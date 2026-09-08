import * as z from 'zod/mini'
import type { Observation } from 'shared/src/contracts'
import { MAX_BUCKETS_PER_OBSERVATION } from 'shared/src/contracts'
import { calcRemainingPercent } from 'shared/src/remaining'
import { zonedWallTimeOf, zonedWallTimeToUtc } from '../lib/zoned-time.js'

/**
 * `claude -p "/usage" --output-format json` の実測出力から rate limit 行だけを
 * 取り出す adapter。
 *
 * CLI は次の形の JSON を返し、人間向けの本文が `result` に入る:
 *
 * ```text
 * Current session: 11% used · resets Sep 1, 9:19pm (Asia/Tokyo)
 * Current week (all models): 13% used · resets Sep 6, 8:59pm (Asia/Tokyo)
 * Current week (Fable): 16% used · resets Sep 6, 8:59pm (Asia/Tokyo)
 * ```
 *
 * `result` には「Top skills」「Top subagents」などの利用内訳も含まれるが、
 * ここで取り出すのは `Current ...: N% used [· resets ...]` 行のみで、
 * skill 名・subagent 名・session 数・repository 情報は一切読まない。
 * transcript や認証ファイルは開かない(CLI の stdout だけを入力とする)。
 */
export type ClaudeUsageLimit = {
  bucketId: string
  label: string
  usedPercent: number
  windowDurationSeconds: number | null
  resetsAt: string | null
}

// CLI の JSON envelope。収集に使うフィールドだけを宣言し、他は捨てる
const claudeUsageEnvelopeSchema = z.object({
  is_error: z.optional(z.nullable(z.boolean())),
  subtype: z.optional(z.nullable(z.string())),
  result: z.optional(z.nullable(z.string()))
})

export type ClaudeUsageEnvelopeResult =
  | { ok: true; text: string }
  | {
      ok: false
      reason: 'invalid_json' | 'unexpected_shape' | 'cli_error' | 'empty_result'
      detail: string
    }

/** CLI stdout(JSON)から人間向け本文を取り出す。本文自体はログへ出さない */
export function parseClaudeUsageEnvelope(stdout: string): ClaudeUsageEnvelopeResult {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return { ok: false, reason: 'invalid_json', detail: 'stdout is not valid JSON' }
  }
  const parsed = claudeUsageEnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: 'unexpected_shape', detail: 'unexpected claude usage JSON shape' }
  }
  if (parsed.data.is_error === true) {
    return {
      ok: false,
      reason: 'cli_error',
      detail: `claude cli reported an error (subtype=${parsed.data.subtype ?? 'unknown'})`
    }
  }
  const text = parsed.data.result ?? ''
  if (text.trim().length === 0) {
    return { ok: false, reason: 'empty_result', detail: 'claude usage result is empty' }
  }
  return { ok: true, text }
}

const SESSION_WINDOW_SECONDS = 5 * 60 * 60
const WEEK_WINDOW_SECONDS = 7 * 24 * 60 * 60

// `Current session: 11% used · resets ...` / `Current week (Fable): 16% used`
const USAGE_LINE_PATTERN = /^(current\b[^:]{0,60}):\s*(\d{1,3}(?:\.\d+)?)\s*%\s*used\b(.*)$/i
const RESETS_SEGMENT_PATTERN = /^resets\s+(.+)$/i
// `Sep 1, 9:19pm (Asia/Tokyo)` / `Sep 6, 21:19 (Asia/Tokyo)`
// 実測では正時のとき分が省略される(`Sep 6, 9pm (Asia/Tokyo)`)ため分は optional
const RESET_TIME_PATTERN =
  /^([A-Za-z]{3,9})\s+(\d{1,2})(?:,)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]{1,64})\)$/i

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

type BucketIdentity = {
  bucketId: string
  label: string
  windowDurationSeconds: number | null
}

/**
 * 表示ラベルから安定した bucketId を決める。bucketId は Hub の
 * `latest_limits` の PK 要素なので、CLI の表記揺れで変わらないよう正規化する。
 * 未知のラベルも捨てずに slug 化して残す(未知 bucket を欠落させない)。
 */
export function toClaudeBucketIdentity(rawLabel: string): BucketIdentity | null {
  const normalized = rawLabel.trim().replace(/\s+/g, ' ')
  if (normalized.length === 0) {
    return null
  }
  if (/^current session$/i.test(normalized)) {
    return {
      bucketId: 'claude:session',
      label: '5h',
      windowDurationSeconds: SESSION_WINDOW_SECONDS
    }
  }
  const weekMatch = /^current week(?:\s*\(([^)]*)\))?$/i.exec(normalized)
  if (weekMatch) {
    const scope = (weekMatch[1] ?? '').trim()
    if (scope.length === 0 || /^all models$/i.test(scope)) {
      return { bucketId: 'claude:week', label: '7d', windowDurationSeconds: WEEK_WINDOW_SECONDS }
    }
    const slug = slugify(scope)
    if (slug.length === 0) {
      return { bucketId: 'claude:week', label: '7d', windowDurationSeconds: WEEK_WINDOW_SECONDS }
    }
    return {
      bucketId: `claude:week:${slug}`,
      label: `7d ${scope}`.slice(0, 32),
      windowDurationSeconds: WEEK_WINDOW_SECONDS
    }
  }
  const slug = slugify(normalized)
  if (slug.length === 0) {
    return null
  }
  // window 長を推測できない未知ラベルは windowDurationSeconds を null にする
  return { bucketId: `claude:${slug}`, label: normalized.slice(0, 32), windowDurationSeconds: null }
}

/**
 * `Sep 1, 9:19pm (Asia/Tokyo)` を ISO 8601(UTC)へ変換する。
 * CLI は年を出さないため observedAt を基準に前後 1 年の候補から最も近いものを選ぶ
 * (年末年始の跨ぎで 1 年ずれないようにする)。
 */
export function parseClaudeResetsAt({
  text,
  observedAt
}: {
  text: string
  observedAt: string
}): string | null {
  const match = RESET_TIME_PATTERN.exec(text.trim())
  if (!match) {
    return null
  }
  const [, monthName, dayText, hourText, minuteText, meridiem, timeZone] = match
  if (!monthName || !dayText || !hourText || !timeZone) {
    return null
  }
  // 分も am/pm も無い `Sep 6, 9 (Asia/Tokyo)` は 24 時間表記か 12 時間表記か
  // 判別できないため採用しない
  if (minuteText === undefined && meridiem === undefined) {
    return null
  }
  const monthIndex = MONTH_INDEX[monthName.slice(0, 3).toLowerCase()]
  if (monthIndex === undefined) {
    return null
  }
  const day = Number(dayText)
  const minute = minuteText === undefined ? 0 : Number(minuteText)
  const hour = toHour24({ hourText, meridiem })
  if (hour === null || day < 1 || day > 31 || minute > 59) {
    return null
  }

  const observedDate = new Date(observedAt)
  if (Number.isNaN(observedDate.getTime())) {
    return null
  }
  const observedWall = zonedWallTimeOf({ date: observedDate, timeZone: timeZone.trim() })
  if (!observedWall) {
    return null
  }

  let best: Date | null = null
  for (const year of [observedWall.year - 1, observedWall.year, observedWall.year + 1]) {
    const candidate = zonedWallTimeToUtc({
      wallTime: { year, month: monthIndex + 1, day, hour, minute },
      timeZone: timeZone.trim()
    })
    if (!candidate) {
      continue
    }
    if (
      !best ||
      Math.abs(candidate.getTime() - observedDate.getTime()) <
        Math.abs(best.getTime() - observedDate.getTime())
    ) {
      best = candidate
    }
  }
  return best ? best.toISOString() : null
}

function toHour24({
  hourText,
  meridiem
}: {
  hourText: string
  meridiem: string | undefined
}): number | null {
  const hour = Number(hourText)
  if (!Number.isInteger(hour)) {
    return null
  }
  if (!meridiem) {
    return hour <= 23 ? hour : null
  }
  if (hour < 1 || hour > 12) {
    return null
  }
  const isPm = meridiem.toLowerCase() === 'pm'
  if (hour === 12) {
    return isPm ? 12 : 0
  }
  return isPm ? hour + 12 : hour
}

/**
 * `/usage` 本文から rate limit 行だけを取り出す。
 * rate limit 行が 1 件も無ければ空配列を返し、呼び出し側は失敗として扱う
 * (fake 値を作らない)。
 */
export function parseClaudeUsageText({
  text,
  observedAt
}: {
  text: string
  observedAt: string
}): ClaudeUsageLimit[] {
  const limits: ClaudeUsageLimit[] = []
  const seen = new Set<string>()

  for (const line of text.split('\n')) {
    const match = USAGE_LINE_PATTERN.exec(line.trim())
    if (!match) {
      continue
    }
    const [, rawLabel, percentText, rest] = match
    if (!rawLabel || !percentText) {
      continue
    }
    const usedPercent = Number(percentText)
    if (!Number.isFinite(usedPercent)) {
      continue
    }
    const identity = toClaudeBucketIdentity(rawLabel)
    if (!identity || seen.has(identity.bucketId)) {
      continue
    }
    seen.add(identity.bucketId)
    limits.push({
      bucketId: identity.bucketId,
      label: identity.label,
      usedPercent,
      windowDurationSeconds: identity.windowDurationSeconds,
      resetsAt: findResetsAt({ rest: rest ?? '', observedAt })
    })
    if (limits.length >= MAX_BUCKETS_PER_OBSERVATION) {
      break
    }
  }
  return limits
}

// `· resets Sep 1, 9:19pm (Asia/Tokyo)` のような中黒区切りの断片から reset を探す
function findResetsAt({ rest, observedAt }: { rest: string; observedAt: string }): string | null {
  for (const segment of rest.split('·')) {
    const trimmed = segment.trim()
    const resets = RESETS_SEGMENT_PATTERN.exec(trimmed)
    if (!resets || !resets[1]) {
      continue
    }
    const parsed = parseClaudeResetsAt({ text: resets[1], observedAt })
    if (parsed) {
      return parsed
    }
  }
  return null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/**
 * 取り出した rate limit を正規化 Observation へ変換する。
 * 有効な bucket が 0 件なら null を返し送信しない
 * (Hub 側の以前の有効値を消さない)。
 */
export function buildClaudeUsageObservation({
  limits,
  sourceId,
  observedAt
}: {
  limits: readonly ClaudeUsageLimit[]
  sourceId: string
  observedAt: string
}): Observation | null {
  if (limits.length === 0) {
    return null
  }
  const buckets = limits.map((limit) => {
    const usedPercent = clampPercent(limit.usedPercent)
    return {
      bucketId: limit.bucketId,
      label: limit.label,
      usedPercent,
      remainingPercent: calcRemainingPercent(usedPercent),
      windowDurationSeconds: limit.windowDurationSeconds,
      resetsAt: limit.resetsAt,
      reached: usedPercent >= 100
    }
  })
  // accountAlias は送らない。Hub が認証 token の accountAlias で正規化する
  return {
    schemaVersion: 1,
    provider: 'claude',
    sourceId,
    observedAt,
    buckets
  }
}

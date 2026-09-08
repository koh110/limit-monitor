/**
 * Claude の `/usage` は reset 時刻を「年なしのローカル時刻 + IANA timezone 名」
 * (例: `Sep 1, 9:19pm (Asia/Tokyo)`)で返す。Hub 契約は offset 付き ISO 8601 を
 * 要求するため、timezone 名から実際の offset を解決して UTC instant へ変換する。
 * 追加依存を持ち込まず `Intl.DateTimeFormat` だけで完結させる。
 */
export type WallTime = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function createFormatter(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    // 未知の timezone 名は RangeError になる
    return null
  }
}

function wallTimeFromParts(parts: Intl.DateTimeFormatPart[]): WallTime | null {
  const read = (type: Intl.DateTimeFormatPartTypes): number | null => {
    const part = parts.find((candidate) => {
      return candidate.type === type
    })
    if (!part) {
      return null
    }
    const value = Number(part.value)
    return Number.isInteger(value) ? value : null
  }
  const year = read('year')
  const month = read('month')
  const day = read('day')
  const hour = read('hour')
  const minute = read('minute')
  const second = read('second')
  if (
    year === null ||
    month === null ||
    day === null ||
    hour === null ||
    minute === null ||
    second === null
  ) {
    return null
  }
  // hourCycle h23 でも実装差で 24 が出た場合は 0 に丸める
  return { year, month, day, hour: hour === 24 ? 0 : hour, minute, second }
}

/** 指定 instant を timezone のローカル壁時計時刻へ変換する */
export function zonedWallTimeOf({
  date,
  timeZone
}: {
  date: Date
  timeZone: string
}): WallTime | null {
  const formatter = createFormatter(timeZone)
  if (!formatter) {
    return null
  }
  return wallTimeFromParts(formatter.formatToParts(date))
}

function offsetMsAt({
  formatter,
  epochMs
}: {
  formatter: Intl.DateTimeFormat
  epochMs: number
}): number | null {
  const wall = wallTimeFromParts(formatter.formatToParts(new Date(epochMs)))
  if (!wall) {
    return null
  }
  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - epochMs
  )
}

/**
 * timezone のローカル壁時計時刻を UTC instant へ変換する。
 * offset は時刻自体に依存する(DST)ため反復して収束させ、最後に
 * 逆変換で往復一致を検証する。存在しない時刻(DST の飛ばされた時刻)や
 * 不正な日付(2/30 等)は null を返す。
 */
export function zonedWallTimeToUtc({
  wallTime,
  timeZone
}: {
  wallTime: Omit<WallTime, 'second'> & { second?: number }
  timeZone: string
}): Date | null {
  const formatter = createFormatter(timeZone)
  if (!formatter) {
    return null
  }
  const second = wallTime.second ?? 0
  const target = Date.UTC(
    wallTime.year,
    wallTime.month - 1,
    wallTime.day,
    wallTime.hour,
    wallTime.minute,
    second
  )
  if (!Number.isFinite(target)) {
    return null
  }

  let epochMs = target
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = offsetMsAt({ formatter, epochMs })
    if (offset === null) {
      return null
    }
    const next = target - offset
    if (next === epochMs) {
      break
    }
    epochMs = next
  }

  const roundTrip = wallTimeFromParts(formatter.formatToParts(new Date(epochMs)))
  if (
    !roundTrip ||
    roundTrip.year !== wallTime.year ||
    roundTrip.month !== wallTime.month ||
    roundTrip.day !== wallTime.day ||
    roundTrip.hour !== wallTime.hour ||
    roundTrip.minute !== wallTime.minute
  ) {
    return null
  }
  return new Date(epochMs)
}

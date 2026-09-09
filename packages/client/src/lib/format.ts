const jstFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

export function formatJst(iso: string | null): string {
  if (iso === null) {
    return '--'
  }
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    return '--'
  }
  return jstFormatter.format(new Date(ms))
}

// Stream Deck と揃えた短い duration 表記(例: 2h14m)
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) {
    return `${days}d${hours}h`
  }
  if (hours > 0) {
    return `${hours}h${minutes}m`
  }
  return `${minutes}m`
}

export function formatUntilReset(resetsAt: string | null, now: Date): string {
  if (resetsAt === null) {
    return '--'
  }
  const ms = Date.parse(resetsAt)
  if (Number.isNaN(ms)) {
    return '--'
  }
  const diff = ms - now.getTime()
  if (diff <= 0) {
    return 'リセット済み'
  }
  return `あと${formatDuration(diff)}`
}

export function formatAgo(observedAt: string, now: Date): string {
  const ms = Date.parse(observedAt)
  if (Number.isNaN(ms)) {
    return '--'
  }
  const diff = now.getTime() - ms
  if (diff < 60_000) {
    return 'たった今'
  }
  return `${formatDuration(diff)}前`
}

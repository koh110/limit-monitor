type Entry = {
  count: number
  windowStartMs: number
}

/**
 * in-memory の fixed window rate limiter。
 * Hub は単一プロセス運用(systemd)のためプロセスローカルで十分。
 */
export function createRateLimiter({ windowMs, max }: { windowMs: number; max: number }) {
  const entries = new Map<string, Entry>()

  return {
    check(key: string, nowMs: number): boolean {
      const entry = entries.get(key)
      if (!entry || nowMs - entry.windowStartMs >= windowMs) {
        entries.set(key, { count: 1, windowStartMs: nowMs })
        return true
      }
      entry.count += 1
      return entry.count <= max
    }
  }
}

export type RateLimiter = ReturnType<typeof createRateLimiter>

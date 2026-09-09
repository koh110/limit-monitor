import type { StatusResponse } from 'shared/src/contracts'
import { statusResponseSchema } from 'shared/src/contracts'
import type { Result } from 'shared/src/index'
import { HUB_BASE_URL } from '../config'

export async function fetchStatus(): Promise<Result<StatusResponse>> {
  try {
    const res = await fetch(new URL('/api/v1/status', HUB_BASE_URL), {
      cache: 'no-store'
    })
    if (!res.ok) {
      return { ok: false, status: res.status, body: `hub returned ${res.status}` }
    }
    const parsed = statusResponseSchema.safeParse(await res.json())
    if (!parsed.success) {
      return { ok: false, status: 502, body: 'unexpected status response shape' }
    }
    return { ok: true, status: res.status, body: parsed.data }
  } catch {
    // Hub へ到達できない(offline)。stale とは区別して表示する
    return { ok: false, status: 0, body: 'hub unreachable' }
  }
}

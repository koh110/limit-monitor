import type { Provider, StatusResponse } from 'shared/src/contracts'
import { statusResponseSchema } from 'shared/src/contracts'
import { refreshRequestResponseSchema, type RefreshStatus } from 'shared/src/control'
import type { Result } from 'shared/src/index'
import { HUB_BASE_URL } from '../config'

export async function fetchStatus(): Promise<Result<StatusResponse>> {
  try {
    const res = await fetch(new URL('/api/v1/status', HUB_BASE_URL), { cache: 'no-store' })
    if (!res.ok) return { ok: false, status: res.status, body: `hub returned ${res.status}` }
    const parsed = statusResponseSchema.safeParse(await res.json())
    if (!parsed.success) return { ok: false, status: 502, body: 'unexpected status response shape' }
    return { ok: true, status: res.status, body: parsed.data }
  } catch {
    return { ok: false, status: 0, body: 'hub unreachable' }
  }
}

export async function requestRefresh(
  provider: Provider,
  accountAlias: string,
  signal?: AbortSignal
) {
  try {
    const res = await fetch('/api/v1/refresh-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, accountAlias }),
      signal
    })
    if (!res.ok) return { ok: false as const, status: res.status }
    const parsed = refreshRequestResponseSchema.safeParse(await res.json())
    return parsed.success
      ? { ok: true as const, body: parsed.data }
      : { ok: false as const, status: 502 }
  } catch {
    return { ok: false as const, status: 0 }
  }
}

export async function fetchRefreshStatus(
  requestId: string,
  signal?: AbortSignal
): Promise<RefreshStatus | null> {
  try {
    const res = await fetch(new URL(`/api/v1/refresh-requests/${requestId}`, HUB_BASE_URL), {
      cache: 'no-store',
      signal
    })
    if (!res.ok) return null
    const parsed = refreshRequestResponseSchema.safeParse(await res.json())
    return parsed.success ? parsed.data.status : null
  } catch {
    return null
  }
}

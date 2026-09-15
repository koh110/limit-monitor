import type { Provider, StatusResponse } from 'shared/src/contracts'
import { statusResponseSchema } from 'shared/src/contracts'
import {
  refreshRequestBodySchema,
  refreshRequestResponseSchema,
  requestIdSchema,
  type RefreshStatus
} from 'shared/src/control'
import type { Result } from 'shared/src/index'
import { HUB_BASE_URL } from '../config'
import { APIResult, client, createFetchOptions, toAPIResult } from './api'

type StatusApiResult = APIResult<typeof client<'/api/v1/status', 'get'>, 200>
const REFRESH_PROXY_BASE_URL = globalThis.location?.origin ?? HUB_BASE_URL
type CreateRefreshApiResult = APIResult<typeof client<'/api/v1/refresh-requests', 'post'>, 202>
type RefreshStatusApiResult = APIResult<
  typeof client<'/api/v1/refresh-requests/{requestId}', 'get'>,
  200
>

export async function fetchStatus(): Promise<Result<StatusResponse>> {
  try {
    const response = await client<'/api/v1/status', 'get'>(
      HUB_BASE_URL,
      createFetchOptions({
        path: '/api/v1/status',
        method: 'get',
        parameters: { query: undefined, header: undefined, path: undefined, cookie: undefined }
      }),
      { cache: 'no-store' }
    )
    const result: StatusApiResult = toAPIResult(response, 200)
    if (result.status !== 200) {
      return { ok: false, status: result.status, body: `hub returned ${result.status}` }
    }
    const parsed = statusResponseSchema.safeParse(result.body)
    if (!parsed.success) return { ok: false, status: 502, body: 'unexpected status response shape' }
    return { ok: true, status: result.status, body: parsed.data }
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
    const requestBody = refreshRequestBodySchema.parse({ provider, accountAlias })
    const response = await client<'/api/v1/refresh-requests', 'post'>(
      REFRESH_PROXY_BASE_URL,
      createFetchOptions({
        path: '/api/v1/refresh-requests',
        method: 'post',
        parameters: { query: undefined, header: undefined, path: undefined, cookie: undefined },
        requestBody
      }),
      { signal }
    )
    const result: CreateRefreshApiResult = toAPIResult(response, 202)
    if (result.status !== 202) return { ok: false as const, status: result.status }
    const parsed = refreshRequestResponseSchema.safeParse(result.body)
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
    const parsedRequestId = requestIdSchema.safeParse(requestId)
    if (!parsedRequestId.success) return null
    const response = await client<'/api/v1/refresh-requests/{requestId}', 'get'>(
      HUB_BASE_URL,
      createFetchOptions({
        path: '/api/v1/refresh-requests/{requestId}',
        method: 'get',
        parameters: {
          query: undefined,
          header: undefined,
          path: { requestId: parsedRequestId.data },
          cookie: undefined
        }
      }),
      { cache: 'no-store', signal }
    )
    const result: RefreshStatusApiResult = toAPIResult(response, 200)
    if (result.status !== 200) return null
    const parsed = refreshRequestResponseSchema.safeParse(result.body)
    return parsed.success ? parsed.data.status : null
  } catch {
    return null
  }
}

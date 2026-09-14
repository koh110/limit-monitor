import { afterEach, expect, test, vi } from 'vite-plus/test'
import { client, createFetchOptions } from './api'

const fetchMock = vi.spyOn(globalThis, 'fetch')

afterEach(() => {
  fetchMock.mockReset()
})

test('TypeSpec operationのrequest bodyとsuccess responseをclientで扱う', async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ schemaVersion: 1, requestId: 'request-1', status: 'queued' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' }
    })
  )

  const options = createFetchOptions({
    path: '/api/v1/refresh-requests',
    method: 'post',
    parameters: { query: undefined, header: undefined, path: undefined, cookie: undefined },
    requestBody: { provider: 'codex', accountAlias: 'primary' }
  })
  const response = await client('https://hub.test', options)

  expect(response).toEqual({
    status: 202,
    body: { schemaVersion: 1, requestId: 'request-1', status: 'queued' }
  })
  expect(fetchMock).toHaveBeenCalledWith(
    'https://hub.test/api/v1/refresh-requests',
    expect.objectContaining({
      method: 'post',
      body: JSON.stringify({ provider: 'codex', accountAlias: 'primary' })
    })
  )
})

test('path parameterをURLへ反映する', async () => {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({ schemaVersion: 1, requestId: 'request-1', status: 'completed' }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    )
  )

  const path = '/api/v1/refresh-requests/{requestId}' as const
  const requestId = 'request/a?x#y'
  const options = createFetchOptions({
    path,
    method: 'get',
    parameters: {
      query: undefined,
      header: undefined,
      path: { requestId },
      cookie: undefined
    }
  })
  await client('https://hub.test', options)

  expect(fetchMock).toHaveBeenCalledWith(
    'https://hub.test/api/v1/refresh-requests/request%2Fa%3Fx%23y',
    expect.objectContaining({ method: 'get' })
  )
})

test('path parameterのdot segmentをURL正規化から保護する', async () => {
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

  const options = createFetchOptions({
    path: '/api/v1/refresh-requests/{requestId}',
    method: 'get',
    parameters: {
      query: undefined,
      header: undefined,
      path: { requestId: '..' },
      cookie: undefined
    }
  })
  await client('https://hub.test', options)

  expect(fetchMock).toHaveBeenCalledWith(
    'https://hub.test/api/v1/refresh-requests/%2E%2E',
    expect.objectContaining({ method: 'get' })
  )
})

test('JSON Content-Typeの大文字小文字に関係なくbodyをparseする', async () => {
  fetchMock.mockResolvedValue(
    new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'Application/JSON' }
    })
  )

  const options = createFetchOptions({
    path: '/api/v1/status',
    method: 'get',
    parameters: { query: undefined, header: undefined, path: undefined, cookie: undefined }
  })
  const response = await client('https://hub.test', options)

  expect(response).toEqual({ status: 200, body: { ok: true } })
})

test('JSONとして不正なエラーbodyでもHTTP statusを維持する', async () => {
  fetchMock.mockResolvedValue(
    new Response('hub unavailable', {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  )

  const options = createFetchOptions({
    path: '/api/v1/status',
    method: 'get',
    parameters: { query: undefined, header: undefined, path: undefined, cookie: undefined }
  })
  const response = await client('https://hub.test', options)

  expect(response).toEqual({ status: 500, body: 'hub unavailable' })
})

createFetchOptions({
  path: '/api/v1/status',
  // @ts-expect-error status operationに実装されていないmethodは許可しない
  method: 'post',
  parameters: { query: undefined, header: undefined, path: undefined, cookie: undefined }
})

const initWithBody: RequestInit = { body: '{}' }
if (globalThis.location?.protocol === 'typecheck:') {
  client(
    'https://hub.test',
    createFetchOptions({
      path: '/api/v1/status',
      method: 'get',
      parameters: { query: undefined, header: undefined, path: undefined, cookie: undefined }
    }),
    // @ts-expect-error operation body is the only body input; RequestInit.body is forbidden
    initWithBody
  )
}

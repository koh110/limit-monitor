import type * as schema from 'shared/src/schema'
import { expect, test } from 'vite-plus/test'
import * as z from 'zod/mini'
import { createTestDb } from '../test/util.js'
import { createApp } from './app.js'
import { INGEST_BODY_LIMIT_BYTES } from './config.js'
import { issueToken } from './features/tokens/store.js'
import { createRateLimiter } from './lib/rate-limit.js'

// TypeSpec(packages/shared/main.tsp)で宣言した contract を runtime 側から固定する。
// 生成型への代入で shape を、Content-Type header で media type を検証する。
type IngestApi = schema.paths['/api/v1/observations']['post']
type IngestResponse = IngestApi['responses']
type StatusByProviderResponse = schema.paths['/api/v1/status/{provider}']['get']['responses']
type HealthzResponse = schema.paths['/healthz']['get']['responses']

const now = new Date('2026-08-23T04:00:00.000Z')

function problemSchemaFor<Status extends number>(status: Status) {
  return z.object({
    type: z.string(),
    title: z.string(),
    status: z.literal(status),
    detail: z.optional(z.string())
  })
}

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    provider: 'codex',
    sourceId: 'dev-machine',
    observedAt: new Date().toISOString(),
    buckets: [
      {
        bucketId: 'codex:primary',
        label: '5h',
        usedPercent: 28.5,
        remainingPercent: 71.5
      }
    ],
    ...overrides
  }
}

function postObservation({
  app,
  token,
  payload
}: {
  app: ReturnType<typeof createApp>
  token?: string
  payload: Record<string, unknown>
}) {
  return app.request('/api/v1/observations', {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
}

test('healthz の 200 は契約どおりの shape と media type で返る', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const res = await app.request('/healthz')
  expect(res.headers.get('Content-Type')).toContain('application/json')
  const body: HealthzResponse['200']['content']['application/json'] = z
    .object({
      status: z.literal('ok'),
      version: z.string(),
      schemaVersion: z.literal(1)
    })
    .parse(await res.json())
  expect(body.status).toBe('ok')
  cleanup()
})

test('ingest の 401 は application/problem+json で返る', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const res = await postObservation({ app, payload: createPayload() })
  expect(res.status).toBe(401)
  expect(res.headers.get('Content-Type')).toContain('application/problem+json')
  const body: IngestResponse['401']['content']['application/problem+json'] = problemSchemaFor(
    401
  ).parse(await res.json())
  expect(body.title).toBe('Unauthorized')
  cleanup()
})

test('ingest の 400 は application/problem+json で返る', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  const res = await postObservation({
    app,
    token: issued.token,
    payload: createPayload({ provider: 'gemini' })
  })
  expect(res.status).toBe(400)
  expect(res.headers.get('Content-Type')).toContain('application/problem+json')
  const body: IngestResponse['400']['content']['application/problem+json'] = problemSchemaFor(
    400
  ).parse(await res.json())
  expect(body.title).toBe('Bad Request')
  cleanup()
})

test('ingest の 403 は application/problem+json で返る', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  const res = await postObservation({
    app,
    token: issued.token,
    payload: createPayload({ sourceId: 'other-machine' })
  })
  expect(res.status).toBe(403)
  expect(res.headers.get('Content-Type')).toContain('application/problem+json')
  const body: IngestResponse['403']['content']['application/problem+json'] = problemSchemaFor(
    403
  ).parse(await res.json())
  expect(body.title).toBe('Forbidden')
  cleanup()
})

test('ingest の 413 は application/problem+json で返る', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  const res = await postObservation({
    app,
    token: issued.token,
    payload: createPayload({ padding: 'x'.repeat(INGEST_BODY_LIMIT_BYTES) })
  })
  expect(res.status).toBe(413)
  expect(res.headers.get('Content-Type')).toContain('application/problem+json')
  const body: IngestResponse['413']['content']['application/problem+json'] = problemSchemaFor(
    413
  ).parse(await res.json())
  expect(body.title).toBe('Content Too Large')
  cleanup()
})

test('ingest の 429 は application/problem+json で返る', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({
    db,
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 })
  })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  await postObservation({ app, token: issued.token, payload: createPayload() })
  const res = await postObservation({ app, token: issued.token, payload: createPayload() })
  expect(res.status).toBe(429)
  expect(res.headers.get('Content-Type')).toContain('application/problem+json')
  const body: IngestResponse['429']['content']['application/problem+json'] = problemSchemaFor(
    429
  ).parse(await res.json())
  expect(body.title).toBe('Too Many Requests')
  cleanup()
})

test('provider 別 status の 400 は application/problem+json で返る', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const res = await app.request('/api/v1/status/gemini')
  expect(res.status).toBe(400)
  expect(res.headers.get('Content-Type')).toContain('application/problem+json')
  const body: StatusByProviderResponse['400']['content']['application/problem+json'] =
    problemSchemaFor(400).parse(await res.json())
  expect(body.title).toBe('Bad Request')
  cleanup()
})

test('未定義 route の 404 は application/json で返る', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const res = await app.request('/api/v1/unknown')
  expect(res.status).toBe(404)
  // 404 は createHttpException を経由せず c.json() で返すため application/json
  expect(res.headers.get('Content-Type')).toContain('application/json')
  expect(res.headers.get('Content-Type')).not.toContain('problem+json')
  const body: schema.components['schemas']['NotFoundError'] = problemSchemaFor(404).parse(
    await res.json()
  )
  expect(body.title).toBe('Not Found')
  cleanup()
})

import { ingestResultSchema, statusResponseSchema } from 'shared/src/contracts'
import { expect, test } from 'vite-plus/test'
import * as z from 'zod/mini'
import { createTestDb } from '../test/util.js'
import { createApp } from './app.js'
import { INGEST_BODY_LIMIT_BYTES } from './config.js'
import { issueToken, revokeToken } from './features/tokens/store.js'
import { createRateLimiter } from './lib/rate-limit.js'

const now = new Date('2026-08-23T04:00:00.000Z')

const problemSchema = z.object({ title: z.string() })

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    provider: 'codex',
    accountAlias: 'default',
    sourceId: 'dev-machine',
    observedAt: new Date().toISOString(),
    buckets: [
      {
        bucketId: 'codex:primary',
        label: '5h',
        usedPercent: 28.5,
        remainingPercent: 71.5,
        windowDurationSeconds: 18000,
        resetsAt: '2026-08-23T07:14:00.000Z'
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

test('healthz は version と schemaVersion を返す', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const res = await app.request('/healthz')
  expect(res.status).toBe(200)
  const body = z
    .object({
      status: z.string(),
      version: z.string(),
      schemaVersion: z.number()
    })
    .parse(await res.json())
  expect(body.status).toBe('ok')
  expect(body.schemaVersion).toBe(1)
  cleanup()
})

test('readyz は migration 済み DB で ok を返す', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const res = await app.request('/readyz')
  expect(res.status).toBe(200)
  cleanup()
})

test('Authorization header がない ingest は 401', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const res = await postObservation({ app, payload: createPayload() })
  expect(res.status).toBe(401)
  cleanup()
})

test('Bearer 以外の scheme は 401', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const res = await app.request('/api/v1/observations', {
    method: 'POST',
    headers: {
      Authorization: 'Basic dXNlcjpwYXNz',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(createPayload())
  })
  expect(res.status).toBe(401)
  cleanup()
})

test('未登録 token は 401', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const res = await postObservation({
    app,
    token: 'lmt_unknown',
    payload: createPayload()
  })
  expect(res.status).toBe(401)
  cleanup()
})

test('失効した token は 401', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  await revokeToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  const res = await postObservation({
    app,
    token: issued.token,
    payload: createPayload()
  })
  expect(res.status).toBe(401)
  cleanup()
})

test('token の sourceId と異なる sourceId への書き込みは 403', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  const res = await postObservation({
    app,
    token: issued.token,
    payload: createPayload({ sourceId: 'other-machine' })
  })
  expect(res.status).toBe(403)
  cleanup()
})

test('token の accountAlias と異なる accountAlias への書き込みは 403', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'main', now })
  const res = await postObservation({
    app,
    token: issued.token,
    payload: createPayload({ accountAlias: 'other-account' })
  })
  expect(res.status).toBe(403)
  cleanup()
})

test('envelope が不正な payload は 400', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  const res = await postObservation({
    app,
    token: issued.token,
    payload: createPayload({ provider: 'gemini' })
  })
  expect(res.status).toBe(400)
  const body = problemSchema.parse(await res.json())
  expect(body.title).toBe('Bad Request')
  cleanup()
})

test('body limit を超えるリクエストは 413', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  const res = await postObservation({
    app,
    token: issued.token,
    payload: createPayload({
      // 未知フィールドは無視されるが、サイズ超過は 413 になる
      padding: 'x'.repeat(INGEST_BODY_LIMIT_BYTES)
    })
  })
  expect(res.status).toBe(413)
  cleanup()
})

test('rate limit を超えた ingest は 429', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({
    db,
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 })
  })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  const first = await postObservation({
    app,
    token: issued.token,
    payload: createPayload()
  })
  expect(first.status).toBe(200)
  const second = await postObservation({
    app,
    token: issued.token,
    payload: createPayload()
  })
  expect(second.status).toBe(429)
  cleanup()
})

test('正常な ingest 後に status API へ反映される', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  const posted = await postObservation({
    app,
    token: issued.token,
    payload: createPayload({ accountAlias: undefined })
  })
  expect(posted.status).toBe(200)
  const ingestResult = ingestResultSchema.parse(await posted.json())
  expect(ingestResult.accepted).toEqual(['codex:primary'])

  const res = await app.request('/api/v1/status')
  expect(res.status).toBe(200)
  const body = statusResponseSchema.parse(await res.json())
  expect(body.schemaVersion).toBe(1)
  expect(body.accounts.length).toBe(1)
  expect(body.accounts[0]?.provider).toBe('codex')
  expect(body.accounts[0]?.accountAlias).toBe('default')
  expect(body.accounts[0]?.buckets[0]?.bucketId).toBe('codex:primary')
  expect(body.accounts[0]?.buckets[0]?.freshness).toBe('fresh')
  cleanup()
})

test('provider 別 status API は対象 provider のみ返す', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'default', now })
  await postObservation({
    app,
    token: issued.token,
    payload: createPayload()
  })
  await postObservation({
    app,
    token: issued.token,
    payload: createPayload({
      provider: 'claude',
      buckets: [
        {
          bucketId: 'claude:five_hour',
          label: '5h',
          usedPercent: 10,
          remainingPercent: 90
        }
      ]
    })
  })

  const res = await app.request('/api/v1/status/claude')
  expect(res.status).toBe(200)
  const body = statusResponseSchema.parse(await res.json())
  expect(body.accounts.length).toBe(1)
  expect(body.accounts[0]?.provider).toBe('claude')
  cleanup()
})

test('未知 provider の status は 400', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const res = await app.request('/api/v1/status/gemini')
  expect(res.status).toBe(400)
  cleanup()
})

test('未定義 route は Problem Details で 404', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db })
  const res = await app.request('/api/v1/unknown')
  expect(res.status).toBe(404)
  const body = problemSchema.parse(await res.json())
  expect(body.title).toBe('Not Found')
  cleanup()
})

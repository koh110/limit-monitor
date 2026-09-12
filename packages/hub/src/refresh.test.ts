import { expect, test } from 'vite-plus/test'
import { refreshRequestResponseSchema } from 'shared/src/control'
import { latestLimits, refreshRequests } from 'shared/src/db/schema'
import { createTestDb } from '../test/util.js'
import { createApp } from './app.js'
import { REFRESH_BODY_LIMIT_BYTES } from './config.js'
import {
  enqueueRefresh,
  getRefresh,
  claimQueuedRefresh,
  requeueExpiredRefreshes,
  updateRefreshStatus
} from './features/refresh/store.js'
import { issueToken, revokeToken } from './features/tokens/store.js'

const REFRESH_TOKEN = 'dashboard-refresh-test-token'

function refreshHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${REFRESH_TOKEN}`
  }
}

test('refresh POST requires a dedicated bearer token', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, refreshApiToken: REFRESH_TOKEN })
  try {
    const response = await app.request('/api/v1/refresh-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'codex', accountAlias: 'main' })
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('Content-Type')).toContain('application/problem+json')
  } finally {
    cleanup()
  }
})

test('offline refresh is durably queued from token account scope', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, refreshApiToken: REFRESH_TOKEN })
  await issueToken({
    db,
    sourceId: 'offline-source',
    accountAlias: 'main',
    now: new Date('2026-09-11T00:00:00.000Z')
  })
  const response = await app.request('/api/v1/refresh-requests', {
    method: 'POST',
    headers: refreshHeaders(),
    body: JSON.stringify({ provider: 'codex', accountAlias: 'main' })
  })
  expect(response.status).toBe(202)
  const body = refreshRequestResponseSchema.parse(await response.json())
  expect(body.status).toBe('queued')
  const status = await app.request(`/api/v1/refresh-requests/${body.requestId}`)
  expect(status.status).toBe(200)
  const statusBody = refreshRequestResponseSchema.parse(await status.json())
  expect(statusBody.status).toBe('queued')
  cleanup()
})

test('duplicate refresh requests reuse the active provider request', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, refreshApiToken: REFRESH_TOKEN })
  await issueToken({
    db,
    sourceId: 'offline-source',
    accountAlias: 'main',
    now: new Date('2026-09-11T00:00:00.000Z')
  })

  const first = await app.request('/api/v1/refresh-requests', {
    method: 'POST',
    headers: refreshHeaders(),
    body: JSON.stringify({ provider: 'codex', accountAlias: 'main' })
  })
  const second = await app.request('/api/v1/refresh-requests', {
    method: 'POST',
    headers: refreshHeaders(),
    body: JSON.stringify({ provider: 'codex', accountAlias: 'main' })
  })
  const firstBody = refreshRequestResponseSchema.parse(await first.json())
  const secondBody = refreshRequestResponseSchema.parse(await second.json())
  expect(secondBody.requestId).toBe(firstBody.requestId)
  expect(secondBody.status).toBe('queued')
  cleanup()
})

test('concurrent refresh requests coalesce to one durable request', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, refreshApiToken: REFRESH_TOKEN })
  await issueToken({
    db,
    sourceId: 'concurrent-source',
    accountAlias: 'main',
    now: new Date('2026-09-11T00:00:00.000Z')
  })
  try {
    const requests = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.request('/api/v1/refresh-requests', {
          method: 'POST',
          headers: refreshHeaders(),
          body: JSON.stringify({ provider: 'codex', accountAlias: 'main' })
        })
      )
    )
    const bodies = await Promise.all(
      requests.map(async (response) => {
        return refreshRequestResponseSchema.parse(await response.json())
      })
    )
    expect(new Set(bodies.map((body) => body.requestId)).size).toBe(1)
    expect(requests.every((response) => response.status === 202)).toBe(true)
  } finally {
    cleanup()
  }
})

test('oversized refresh body returns Problem Details 413', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, refreshApiToken: REFRESH_TOKEN })
  try {
    const response = await app.request('/api/v1/refresh-requests', {
      method: 'POST',
      headers: refreshHeaders(),
      body: JSON.stringify({
        provider: 'codex',
        accountAlias: 'main',
        padding: 'x'.repeat(REFRESH_BODY_LIMIT_BYTES)
      })
    })
    expect(response.status).toBe(413)
    expect(response.headers.get('Content-Type')).toContain('application/problem+json')
  } finally {
    cleanup()
  }
})

test('invalid refresh JSON and body use Problem Details', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, refreshApiToken: REFRESH_TOKEN })
  try {
    const malformed = await app.request('/api/v1/refresh-requests', {
      method: 'POST',
      headers: refreshHeaders(),
      body: '{malformed'
    })
    expect(malformed.status).toBe(400)
    expect(malformed.headers.get('Content-Type')).toContain('application/problem+json')

    const invalid = await app.request('/api/v1/refresh-requests', {
      method: 'POST',
      headers: refreshHeaders(),
      body: JSON.stringify({ provider: 'codex' })
    })
    expect(invalid.status).toBe(400)
    expect(invalid.headers.get('Content-Type')).toContain('application/problem+json')
  } finally {
    cleanup()
  }
})

test('refresh routes to the source with the newest account observation', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, refreshApiToken: REFRESH_TOKEN })
  try {
    await db.insert(latestLimits).values([
      {
        provider: 'codex',
        accountAlias: 'main',
        bucketId: 'a-older',
        label: 'older',
        usedPercent: 10,
        remainingPercent: 90,
        windowDurationSeconds: 18_000,
        resetsAt: '2026-09-11T05:00:00.000Z',
        observedAt: '2026-09-11T00:00:00.000Z',
        receivedAt: '2026-09-11T00:00:01.000Z',
        sourceId: 'older-source',
        reached: false
      },
      {
        provider: 'codex',
        accountAlias: 'main',
        bucketId: 'z-newer',
        label: 'newer',
        usedPercent: 20,
        remainingPercent: 80,
        windowDurationSeconds: 18_000,
        resetsAt: '2026-09-11T05:00:00.000Z',
        observedAt: '2026-09-11T00:10:00.000Z',
        receivedAt: '2026-09-11T00:10:01.000Z',
        sourceId: 'newer-source',
        reached: false
      }
    ])

    const response = await app.request('/api/v1/refresh-requests', {
      method: 'POST',
      headers: refreshHeaders(),
      body: JSON.stringify({ provider: 'codex', accountAlias: 'main' })
    })
    const body = refreshRequestResponseSchema.parse(await response.json())
    const rows = await db.select().from(refreshRequests)
    const request = rows.find((row) => row.id === body.requestId)
    expect(request?.sourceId).toBe('newer-source')
  } finally {
    cleanup()
  }
})

test('refresh fallback routes to the newest collector token for an account', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, refreshApiToken: REFRESH_TOKEN })
  try {
    await issueToken({
      db,
      sourceId: 'a-old-token-source',
      accountAlias: 'main',
      now: new Date('2026-09-11T00:00:00.000Z')
    })
    await issueToken({
      db,
      sourceId: 'z-new-token-source',
      accountAlias: 'main',
      now: new Date('2026-09-11T00:10:00.000Z')
    })

    const response = await app.request('/api/v1/refresh-requests', {
      method: 'POST',
      headers: refreshHeaders(),
      body: JSON.stringify({ provider: 'codex', accountAlias: 'main' })
    })
    const body = refreshRequestResponseSchema.parse(await response.json())
    const rows = await db.select().from(refreshRequests)
    const request = rows.find((row) => row.id === body.requestId)
    expect(request?.sourceId).toBe('z-new-token-source')
  } finally {
    cleanup()
  }
})

test('refresh fallback skips revoked collector tokens', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, refreshApiToken: REFRESH_TOKEN })
  try {
    await issueToken({
      db,
      sourceId: 'valid-token-source',
      accountAlias: 'main',
      now: new Date('2026-09-11T00:00:00.000Z')
    })
    await issueToken({
      db,
      sourceId: 'revoked-token-source',
      accountAlias: 'main',
      now: new Date('2026-09-11T00:10:00.000Z')
    })
    await revokeToken({
      db,
      sourceId: 'revoked-token-source',
      accountAlias: 'main',
      now: new Date('2026-09-11T00:11:00.000Z')
    })

    const response = await app.request('/api/v1/refresh-requests', {
      method: 'POST',
      headers: refreshHeaders(),
      body: JSON.stringify({ provider: 'codex', accountAlias: 'main' })
    })
    const body = refreshRequestResponseSchema.parse(await response.json())
    const rows = await db.select().from(refreshRequests)
    const request = rows.find((row) => row.id === body.requestId)
    expect(request?.sourceId).toBe('valid-token-source')
  } finally {
    cleanup()
  }
})

test('期限切れの queued refresh だけを purge し、fresh と terminal は保持する', async () => {
  const { db, cleanup } = createTestDb()
  const now = new Date('2026-09-12T00:00:00.000Z')
  try {
    const stale = await enqueueRefresh({
      db,
      provider: 'codex',
      accountAlias: 'main',
      sourceId: 'stale-queued-source',
      now: new Date('2026-09-11T22:00:00.000Z')
    })
    const fresh = await enqueueRefresh({
      db,
      provider: 'claude',
      accountAlias: 'main',
      sourceId: 'fresh-queued-source',
      now: new Date('2026-09-11T23:30:00.000Z')
    })
    const terminal = await enqueueRefresh({
      db,
      provider: 'grok',
      accountAlias: 'main',
      sourceId: 'terminal-source',
      now: new Date('2026-09-11T22:00:00.000Z')
    })
    const terminalClaim = await claimQueuedRefresh({ db, id: terminal.id, now })
    expect(terminalClaim).not.toBeNull()
    if (!terminalClaim) return
    await updateRefreshStatus({
      db,
      id: terminal.id,
      leaseId: terminalClaim.leaseId,
      status: 'completed',
      now
    })

    await requeueExpiredRefreshes({
      db,
      now,
      leaseTimeoutMs: 60_000,
      queuedRetentionMs: 60 * 60 * 1000
    })

    expect(await getRefresh({ db, id: stale.id })).toBeNull()
    expect(await getRefresh({ db, id: fresh.id })).not.toBeNull()
    expect((await getRefresh({ db, id: terminal.id }))?.status).toBe('completed')
  } finally {
    cleanup()
  }
})

test('stale worker lifecycle updates cannot complete a redelivered lease', async () => {
  const { db, cleanup } = createTestDb()
  const queuedAt = new Date('2026-09-11T23:59:00.000Z')
  const startedAt = new Date('2026-09-11T23:59:02.000Z')
  const requeueAt = new Date('2026-09-12T00:01:00.000Z')
  try {
    const request = await enqueueRefresh({
      db,
      provider: 'codex',
      accountAlias: 'main',
      sourceId: 'lease-fence-source',
      now: queuedAt
    })
    const firstClaim = await claimQueuedRefresh({ db, id: request.id, now: queuedAt })
    expect(firstClaim).not.toBeNull()
    if (!firstClaim) return
    await updateRefreshStatus({
      db,
      id: request.id,
      status: 'running',
      leaseId: firstClaim.leaseId,
      now: startedAt
    })

    await requeueExpiredRefreshes({ db, now: requeueAt, leaseTimeoutMs: 60_000 })
    const secondClaim = await claimQueuedRefresh({ db, id: request.id, now: requeueAt })
    expect(secondClaim).not.toBeNull()
    if (!secondClaim) return
    expect(secondClaim.leaseId).not.toBe(firstClaim.leaseId)

    await updateRefreshStatus({
      db,
      id: request.id,
      status: 'completed',
      leaseId: firstClaim.leaseId,
      now: requeueAt
    })
    const afterStaleCompletion = await getRefresh({ db, id: request.id })
    expect(afterStaleCompletion?.status).toBe('dispatched')
    expect(afterStaleCompletion?.leaseId).toBe(secondClaim.leaseId)

    await updateRefreshStatus({
      db,
      id: request.id,
      status: 'completed',
      leaseId: secondClaim.leaseId,
      now: requeueAt
    })
    expect((await getRefresh({ db, id: request.id }))?.status).toBe('completed')
  } finally {
    cleanup()
  }
})

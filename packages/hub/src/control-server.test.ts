import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vite-plus/test'
import { refreshRequests } from 'shared/src/db/schema'
import { attachControlServer, dispatchQueued } from './features/control-server.js'
import { CONTROL_MAX_PAYLOAD_BYTES } from 'shared/src/control'
import {
  claimQueuedRefresh,
  enqueueRefresh,
  getRefresh,
  REFRESH_LEASE_TIMEOUT_MS,
  updateRefreshStatus
} from './features/refresh/store.js'
import { issueToken } from './features/tokens/store.js'
import { createTestDb } from '../test/util.js'

async function waitFor<T>(read: () => Promise<T | null>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null && predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('integration test deadline exceeded')
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket message timeout')), 2_000)
    ws.once('message', (raw) => {
      clearTimeout(timer)
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>)
    })
    ws.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

test('control WebSocket dispatches queued refresh and accepts scoped lifecycle updates', async () => {
  const { db, cleanup } = createTestDb()
  const server = createServer()
  const control = attachControlServer({ server, db, intervalMs: 60_000 })
  const issued = await issueToken({
    db,
    sourceId: 'integration-source',
    accountAlias: 'main',
    now: new Date('2026-09-11T00:00:00.000Z')
  })
  const request = await enqueueRefresh({
    db,
    provider: 'codex',
    accountAlias: 'main',
    sourceId: 'integration-source',
    now: new Date(Date.now() - 1_000)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/collector/control`, {
    headers: { Authorization: `Bearer ${issued.token}` }
  })
  try {
    const firstMessage = nextMessage(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const refresh = await firstMessage
    expect(refresh).toMatchObject({ type: 'refresh', requestId: request.id, provider: 'codex' })
    const leaseId = refresh.leaseId
    expect(typeof leaseId).toBe('string')

    const heartbeat = nextMessage(ws)
    ws.send(JSON.stringify({ type: 'heartbeat', schemaVersion: 1 }))
    await expect(heartbeat).resolves.toMatchObject({ type: 'heartbeat', schemaVersion: 1 })

    await waitFor(
      async () => (await getRefresh({ db, id: request.id }))?.status ?? null,
      (status) => status === 'dispatched'
    )

    ws.send(JSON.stringify({ type: 'job_started', requestId: request.id, leaseId }))
    await waitFor(
      async () => (await getRefresh({ db, id: request.id }))?.status ?? null,
      (status) => status === 'running'
    )
    ws.send(JSON.stringify({ type: 'job_finished', requestId: request.id, leaseId, ok: true }))
    await waitFor(
      async () => (await getRefresh({ db, id: request.id }))?.status ?? null,
      (status) => status === 'completed'
    )

    ws.send('{malformed')
    expect(ws.readyState).toBe(WebSocket.OPEN)
  } finally {
    ws.close()
    control.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    cleanup()
  }
})

test('worker failure is reflected as a failed manual refresh', async () => {
  const { db, cleanup } = createTestDb()
  const server = createServer()
  const control = attachControlServer({ server, db, intervalMs: 60_000 })
  const issued = await issueToken({
    db,
    sourceId: 'failure-source',
    accountAlias: 'main',
    now: new Date('2026-09-11T00:00:00.000Z')
  })
  const request = await enqueueRefresh({
    db,
    provider: 'claude',
    accountAlias: 'main',
    sourceId: 'failure-source',
    now: new Date(Date.now() - 1_000)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/collector/control`, {
    headers: { Authorization: `Bearer ${issued.token}` }
  })
  try {
    const dispatched = nextMessage(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const refresh = await dispatched
    const leaseId = refresh.leaseId
    expect(typeof leaseId).toBe('string')
    ws.send(JSON.stringify({ type: 'job_started', requestId: request.id, leaseId }))
    await waitFor(
      async () => (await getRefresh({ db, id: request.id }))?.status ?? null,
      (status) => status === 'running'
    )
    ws.send(JSON.stringify({ type: 'job_finished', requestId: request.id, leaseId, ok: false }))
    const failed = await waitFor(
      async () => await getRefresh({ db, id: request.id }),
      (value) => value?.status === 'failed'
    )
    expect(failed.errorCode).toBe('worker_failed')
  } finally {
    ws.close()
    control.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    cleanup()
  }
})

test('connected agent receives an expired lease redelivery', async () => {
  const { db, cleanup } = createTestDb()
  const server = createServer()
  const control = attachControlServer({
    server,
    db,
    intervalMs: 60_000,
    leaseTimeoutMs: 20,
    refreshLeaseIntervalMs: 10
  })
  const issued = await issueToken({
    db,
    sourceId: 'connected-lease-source',
    accountAlias: 'main',
    now: new Date('2026-09-11T00:00:00.000Z')
  })
  const request = await enqueueRefresh({
    db,
    provider: 'codex',
    accountAlias: 'main',
    sourceId: 'connected-lease-source',
    now: new Date(Date.now() - 1_000)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/collector/control`, {
    headers: { Authorization: `Bearer ${issued.token}` }
  })
  try {
    const first = nextMessage(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const firstMessage = await first
    const firstLeaseId = firstMessage.leaseId
    expect(typeof firstLeaseId).toBe('string')
    ws.send(JSON.stringify({ type: 'job_started', requestId: request.id, leaseId: firstLeaseId }))
    await waitFor(
      async () => (await getRefresh({ db, id: request.id }))?.status ?? null,
      (status) => status === 'running'
    )

    const redelivery = nextMessage(ws)
    const expiredAt = new Date(Date.now() - 100)
    await db
      .update(refreshRequests)
      .set({ startedAt: expiredAt.toISOString() })
      .where(eq(refreshRequests.id, request.id))
    const redeliveryMessage = await redelivery
    expect(redeliveryMessage).toMatchObject({
      type: 'refresh',
      requestId: request.id,
      provider: 'codex'
    })
    expect(redeliveryMessage.leaseId).not.toBe(firstLeaseId)
    await waitFor(
      async () => (await getRefresh({ db, id: request.id }))?.status ?? null,
      (status) => status === 'dispatched'
    )
  } finally {
    ws.close()
    control.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    cleanup()
  }
})

test('expired worker lease returns to queued before reconnect dispatch', async () => {
  const { db, cleanup } = createTestDb()
  const server = createServer()
  const control = attachControlServer({ server, db, intervalMs: 60_000 })
  const issued = await issueToken({
    db,
    sourceId: 'lease-source',
    accountAlias: 'main',
    now: new Date('2026-09-11T00:00:00.000Z')
  })
  const request = await enqueueRefresh({
    db,
    provider: 'grok',
    accountAlias: 'main',
    sourceId: 'lease-source',
    now: new Date(Date.now() - 1_000)
  })
  const expiredAt = new Date(Date.now() - REFRESH_LEASE_TIMEOUT_MS - 1_000)
  const claim = await claimQueuedRefresh({ db, id: request.id, now: expiredAt })
  expect(claim).not.toBeNull()
  if (!claim) return
  await updateRefreshStatus({
    db,
    id: request.id,
    leaseId: claim.leaseId,
    status: 'running',
    now: expiredAt
  })
  expect((await getRefresh({ db, id: request.id }))?.status).toBe('running')

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/collector/control`, {
    headers: { Authorization: `Bearer ${issued.token}` }
  })
  try {
    const dispatched = nextMessage(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const message = await dispatched
    expect(message).toMatchObject({
      type: 'refresh',
      requestId: request.id,
      provider: 'grok'
    })
    const current = await waitFor(
      async () => await getRefresh({ db, id: request.id }),
      (value) => value?.status === 'dispatched'
    )
    expect(current.dispatchedAt).not.toBeNull()
    expect(current.startedAt).toBeNull()
  } finally {
    ws.close()
    control.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    cleanup()
  }
})

test('oversized control frames close the client without terminating the Hub server', async () => {
  const { db, cleanup } = createTestDb()
  const server = createServer()
  const control = attachControlServer({ server, db, intervalMs: 60_000 })
  const issued = await issueToken({
    db,
    sourceId: 'payload-limit-source',
    accountAlias: 'main',
    now: new Date('2026-09-11T00:00:00.000Z')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const oversized = Buffer.alloc(CONTROL_MAX_PAYLOAD_BYTES + 1, 'x')
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/collector/control`, {
    headers: { Authorization: 'Bearer ' + issued.token }
  })
  const events: string[] = []
  ws.on('error', () => events.push('error'))
  ws.on('close', () => events.push('close'))

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.send(oversized)
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && !events.includes('close')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(events).toContain('close')

    const second = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/collector/control`, {
      headers: {
        Authorization: 'Bearer ' + issued.token
      }
    })
    try {
      await new Promise<void>((resolve, reject) => {
        second.once('open', resolve)
        second.once('error', reject)
      })
      expect(second.readyState).toBe(WebSocket.OPEN)
    } finally {
      second.close()
    }
  } finally {
    ws.close()
    control.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    cleanup()
  }
})

test('concurrent dispatchers claim a queued refresh only once', async () => {
  const { db, cleanup } = createTestDb()
  const issued = await issueToken({
    db,
    sourceId: 'claim-source',
    accountAlias: 'main',
    now: new Date('2026-09-11T00:00:00.000Z')
  })
  const request = await enqueueRefresh({
    db,
    provider: 'codex',
    accountAlias: 'main',
    sourceId: 'claim-source',
    now: new Date(Date.now() - 1_000)
  })
  const messages: unknown[] = []
  const send = (message: unknown) => {
    messages.push(message)
    return true
  }

  try {
    await Promise.all([
      dispatchQueued(
        db,
        { sourceId: issued.sourceId, accountAlias: issued.accountAlias },
        send,
        60_000,
        false
      ),
      dispatchQueued(
        db,
        { sourceId: issued.sourceId, accountAlias: issued.accountAlias },
        send,
        60_000,
        false
      )
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: 'refresh', requestId: request.id })
    expect((await getRefresh({ db, id: request.id }))?.status).toBe('dispatched')
  } finally {
    cleanup()
  }
})

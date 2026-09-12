import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { expect, test } from 'vite-plus/test'
import { createAgent, createTriggerQueue } from './agent.js'
import { CONTROL_MAX_PAYLOAD_BYTES } from 'shared/src/control'

test('agent queue coalesces periodic and same-provider manual triggers while worker runs', async () => {
  const calls: string[] = []
  let release: (() => void) | undefined
  const queue = createTriggerQueue(async (message) => {
    calls.push(message.type === 'refresh' ? `${message.type}:${message.provider}` : message.type)
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  expect(
    queue.enqueue({ type: 'collect', triggerId: '00000000-0000-4000-8000-000000000001' })
  ).toBe(true)
  expect(
    queue.enqueue({ type: 'collect', triggerId: '00000000-0000-4000-8000-000000000002' })
  ).toBe(true)
  expect(
    queue.enqueue({
      type: 'refresh',
      requestId: '00000000-0000-4000-8000-000000000003',
      leaseId: '00000000-0000-4000-8000-000000000103',
      provider: 'codex'
    })
  ).toBe(true)
  expect(
    queue.enqueue({
      type: 'refresh',
      requestId: '00000000-0000-4000-8000-000000000004',
      leaseId: '00000000-0000-4000-8000-000000000104',
      provider: 'codex'
    })
  ).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  release?.()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(calls).toEqual(['collect', 'refresh:codex'])
})

test('agent queue ignores arbitrary commands', () => {
  const queue = createTriggerQueue(async () => {})
  expect(queue.enqueue({ type: 'exec', command: 'id' })).toBe(false)
})

test('agent module has no provider adapter imports and never uses a shell', () => {
  const source = fs.readFileSync(new URL('./agent.ts', import.meta.url), 'utf8')
  expect(source).not.toMatch(/sources\/(codex|claude|grok)/)
  expect(source).toContain('shell: false')
  expect(source).toContain("'worker.js'")
})

test('agent reconnects after a Hub restart and emits heartbeat on the new session', async () => {
  let firstServer: WebSocketServer | undefined
  let secondServer: WebSocketServer | undefined
  let restarted = false
  let connections = 0
  let heartbeatMessages = 0
  let workerRuns = 0
  let port = 0

  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(
      `agent reconnect integration deadline exceeded (connections=${connections}, workers=${workerRuns}, heartbeats=${heartbeatMessages}, restarted=${restarted}, secondServer=${secondServer !== undefined})`
    )
  }

  const attach = (server: WebSocketServer, restart: boolean) => {
    server.on('connection', (client) => {
      connections += 1
      client.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string }
        if (message.type === 'heartbeat') heartbeatMessages += 1
      })
      if (restart && !restarted) {
        restarted = true
        setTimeout(() => {
          client.close()
          server.close(() => {
            secondServer = new WebSocketServer({ port })
            attach(secondServer, false)
          })
        }, 20)
      }
    })
  }

  firstServer = new WebSocketServer({ port: 0 })
  attach(firstServer, true)
  await new Promise<void>((resolve) => firstServer?.once('listening', () => resolve()))
  port = (firstServer.address() as AddressInfo).port
  const agent = createAgent({
    hubUrl: `http://127.0.0.1:${port}`,
    readToken: () => 'integration-token',
    heartbeatMs: 10,
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
    random: () => 0,
    runWorker: async () => {
      workerRuns += 1
      return true
    }
  })

  try {
    agent.start()
    await waitFor(() => connections >= 2 && heartbeatMessages > 0 && workerRuns >= 2)
  } finally {
    agent.stop()
    const servers = [restarted ? undefined : firstServer, secondServer].filter(
      (server): server is WebSocketServer => server !== undefined
    )
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
          })
      )
    )
  }

  expect(connections).toBeGreaterThanOrEqual(2)
  expect(workerRuns).toBeGreaterThanOrEqual(2)
  expect(heartbeatMessages).toBeGreaterThan(0)
})

test('agent reconnects after an oversized Hub control frame', async () => {
  let server: WebSocketServer | undefined
  let connections = 0
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`oversized-frame reconnect deadline exceeded (connections=${connections})`)
  }

  server = new WebSocketServer({ port: 0 })
  server.on('connection', (client) => {
    connections += 1
    if (connections === 1) {
      client.send(Buffer.alloc(CONTROL_MAX_PAYLOAD_BYTES + 1, 'x'))
    }
  })
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()))
  const port = (server.address() as AddressInfo).port
  const agent = createAgent({
    hubUrl: `http://127.0.0.1:${port}`,
    readToken: () => 'integration-token',
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
    random: () => 0,
    runWorker: async () => true
  })

  try {
    agent.start()
    await waitFor(() => connections >= 2)
  } finally {
    agent.stop()
    for (const client of server.clients) client.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  }

  expect(connections).toBeGreaterThanOrEqual(2)
})

test('agent reconnects when heartbeat acknowledgements stop', async () => {
  let server: WebSocketServer | undefined
  let connections = 0
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`heartbeat-timeout reconnect deadline exceeded (connections=${connections})`)
  }

  server = new WebSocketServer({ port: 0 })
  server.on('connection', () => {
    connections += 1
  })
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()))
  const port = (server.address() as AddressInfo).port
  const agent = createAgent({
    hubUrl: `http://127.0.0.1:${port}`,
    readToken: () => 'integration-token',
    heartbeatMs: 20,
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
    random: () => 0,
    runWorker: async () => true
  })

  try {
    agent.start()
    await waitFor(() => connections >= 2)
  } finally {
    agent.stop()
    for (const client of server.clients) client.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  }

  expect(connections).toBeGreaterThanOrEqual(2)
})

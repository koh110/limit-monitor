import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vite-plus/test'
import type { Observation } from 'shared/src/contracts'
import { sendObservation } from './send.js'

const observation: Observation = {
  schemaVersion: 1,
  provider: 'codex',
  sourceId: 'dev-machine',
  observedAt: '2026-09-01T11:36:47.683Z',
  buckets: [
    {
      bucketId: 'codex:x',
      label: '5h',
      usedPercent: 1,
      remainingPercent: 99,
      windowDurationSeconds: 18000,
      resetsAt: null,
      reached: false
    }
  ]
}

type Server = http.Server & { received: number }

function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<Server> {
  const server = http.createServer(handler) as Server
  server.received = 0
  server.on('request', () => {
    server.received += 1
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server)
    })
  })
}

function url(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const close = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.closeAllConnections?.()
    server.close((error) => (error ? reject(error) : resolve()))
  })

let server: Server | null = null

afterEach(async () => {
  if (server) {
    const current = server
    server = null
    await close(current)
  }
})

test('fetch が finite timeout を持ち、超過時は明確な失敗 Outcome(status 0)を返す', async () => {
  // 応答を一切返さず request を受け付け続ける Hub を再現する
  server = await listen(() => {})
  const startedAt = Date.now()
  const result = await sendObservation({
    hubUrl: url(server!),
    token: 't',
    observation,
    timeoutMs: 300
  })
  const elapsed = Date.now() - startedAt
  expect(server!.received).toBe(1) // 接続自体は成立し、応答待ちで timeout した
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.status).toBe(0)
    expect(result.body).toMatch(/abort|timeout/i)
  }
  expect(elapsed).toBeLessThan(5000) // fetch が吊るされず finite に決着している
})

test('正常応答(200 + ingest result)は timeout を付けても成功 Outcome を返す', async () => {
  server = await listen((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        schemaVersion: 1,
        accepted: ['codex:x'],
        skipped: [],
        rejected: []
      })
    )
  })
  const result = await sendObservation({
    hubUrl: url(server!),
    token: 't',
    observation,
    timeoutMs: 5000
  })
  expect(result).toEqual({
    ok: true,
    status: 200,
    body: { schemaVersion: 1, accepted: ['codex:x'], skipped: [], rejected: [] }
  })
})

test('HTTP エラー(500)は status を持つ失敗 Outcome を返す', async () => {
  server = await listen((_req, res) => {
    res.writeHead(500)
    res.end('internal error')
  })
  const result = await sendObservation({
    hubUrl: url(server!),
    token: 't',
    observation,
    timeoutMs: 5000
  })
  expect(result).toEqual({ ok: false, status: 500, body: 'internal error' })
})

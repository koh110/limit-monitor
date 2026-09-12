import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import {
  controlMessageSchema,
  CONTROL_MAX_PAYLOAD_BYTES,
  type ControlMessage
} from 'shared/src/control'
import { HUB_TOKEN, HUB_TOKEN_FILE, HUB_URL } from './config.js'

type TriggerMessage = Extract<ControlMessage, { type: 'collect' | 'refresh' }>
type CompletionMessage = Extract<ControlMessage, { type: 'job_finished' }>
type WorkerRunner = (message: TriggerMessage) => Promise<boolean>
type SocketFactory = (url: URL, token: string) => WebSocket

export type AgentOptions = {
  hubUrl: string
  readToken: () => string
  runWorker?: WorkerRunner
  socketFactory?: SocketFactory
  reconnectMinMs?: number
  reconnectMaxMs?: number
  heartbeatMs?: number
  random?: () => number
}

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const HEARTBEAT_MS = 30_000

export function createTriggerQueue(run: (message: TriggerMessage) => Promise<void>) {
  let running = false
  let periodicPending = false
  // Hub は sourceId + provider + accountAlias の active request を部分ユニーク index で
  // 1 件に coalesce するため、1 接続内の同一 provider も最新 request だけを保持する。
  // Map の provider keying は意図した重複排除であり、requestId 単位の配送契約ではない。
  const manualPending = new Map<string, TriggerMessage>()

  async function drain() {
    if (running) return
    const next =
      manualPending.values().next().value ??
      (periodicPending ? { type: 'collect', triggerId: randomUUID() } : undefined)
    if (!next) return
    if (next.type === 'collect') periodicPending = false
    else manualPending.delete(next.provider)
    running = true
    try {
      await run(next)
    } finally {
      running = false
      void drain()
    }
  }

  return {
    enqueue(message: unknown) {
      const parsed = controlMessageSchema.safeParse(message)
      if (!parsed.success || (parsed.data.type !== 'collect' && parsed.data.type !== 'refresh')) {
        return false
      }
      if (parsed.data.type === 'collect') periodicPending = true
      else manualPending.set(parsed.data.provider, parsed.data)
      void drain()
      return true
    },
    isRunning: () => running,
    pending: () => ({ periodic: periodicPending, manual: manualPending.size })
  }
}

export function spawnWorker({
  workerPath,
  provider,
  reason = provider ? 'manual' : 'periodic',
  onExit
}: {
  workerPath: string
  provider?: string
  reason?: 'periodic' | 'manual'
  onExit: (code: number | null) => void
}) {
  const args = [workerPath, `--reason=${reason}`]
  if (provider) args.push(`--provider=${provider}`)
  const child = spawn(process.execPath, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // Child output is intentionally not forwarded to the control channel, but the
  // pipes must be drained so a verbose vendor CLI cannot block the worker.
  child.stdout?.resume()
  child.stderr?.resume()
  let settled = false
  const settle = (code: number | null) => {
    if (settled) return
    settled = true
    onExit(code)
  }
  child.once('exit', settle)
  child.once('error', () => settle(null))
  return child
}

export function workerPath() {
  return path.join(import.meta.dirname, 'worker.js')
}

export function createAgent(options: AgentOptions) {
  const reconnectMinMs = options.reconnectMinMs ?? RECONNECT_MIN_MS
  const reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_MS
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const random = options.random ?? Math.random
  const socketFactory =
    options.socketFactory ??
    ((url: URL, token: string) =>
      new WebSocket(url, {
        headers: {
          Authorization: ['Bearer', token].join(' ')
        },
        maxPayload: CONTROL_MAX_PAYLOAD_BYTES
      }))

  let socket: WebSocket | null = null
  let reconnectTimer: NodeJS.Timeout | undefined
  let heartbeatTimer: NodeJS.Timeout | undefined
  let reconnectDelayMs = reconnectMinMs
  let stopped = true
  const pendingCompletions = new Map<string, CompletionMessage>()

  function sendControl(message: ControlMessage): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (message.type === 'job_finished') pendingCompletions.set(message.requestId, message)
      return false
    }
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      if (message.type === 'job_finished') pendingCompletions.set(message.requestId, message)
      return false
    }
  }

  function flushPendingCompletions(): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    for (const [requestId, message] of pendingCompletions) {
      try {
        socket.send(JSON.stringify(message))
        pendingCompletions.delete(requestId)
      } catch {
        return
      }
    }
  }

  const runWorker: WorkerRunner =
    options.runWorker ??
    ((message) => {
      return new Promise<boolean>((resolve) => {
        try {
          spawnWorker({
            workerPath: workerPath(),
            provider: message.type === 'refresh' ? message.provider : undefined,
            reason: message.type === 'refresh' ? 'manual' : 'periodic',
            onExit: (code) => resolve(code === 0)
          })
        } catch {
          resolve(false)
        }
      })
    })

  const queue = createTriggerQueue(async (message) => {
    const requestId = message.type === 'refresh' ? message.requestId : undefined
    const leaseId = message.type === 'refresh' ? message.leaseId : undefined
    if (requestId && leaseId) sendControl({ type: 'job_started', requestId, leaseId })
    let ok = false
    try {
      ok = await runWorker(message)
    } catch {
      ok = false
    }
    if (requestId && leaseId) sendControl({ type: 'job_finished', requestId, leaseId, ok })
  })

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return
    const jitterMs = Math.floor(random() * 250)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, reconnectDelayMs + jitterMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, reconnectMaxMs)
  }

  function connect(): void {
    if (stopped) return
    let token: string
    try {
      token = options.readToken()
    } catch (error) {
      console.error(error)
      scheduleReconnect()
      return
    }

    const url = new URL('/api/v1/collector/control', options.hubUrl.replace(/^http/, 'ws'))
    const nextSocket = socketFactory(url, token)
    socket = nextSocket
    let lastHeartbeatAckAt = 0

    nextSocket.on('open', () => {
      reconnectDelayMs = reconnectMinMs
      lastHeartbeatAckAt = Date.now()
      flushPendingCompletions()
      heartbeatTimer = setInterval(() => {
        if (Date.now() - lastHeartbeatAckAt >= heartbeatMs * 2) {
          nextSocket.terminate()
          return
        }
        sendControl({ type: 'heartbeat', schemaVersion: 1 })
      }, heartbeatMs)
      // cold-start と reconnect 後の freshness 回復は provider 非依存で1回だけ要求する。
      queue.enqueue({ type: 'collect', triggerId: randomUUID() })
    })
    nextSocket.on('message', (data) => {
      try {
        const parsed = controlMessageSchema.safeParse(JSON.parse(data.toString()))
        if (!parsed.success) return
        if (parsed.data.type === 'heartbeat') {
          lastHeartbeatAckAt = Date.now()
          return
        }
        queue.enqueue(parsed.data)
      } catch {
        // malformed control data は agent を終了させない。
      }
    })
    nextSocket.on('close', () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = undefined
      }
      if (socket === nextSocket) socket = null
      scheduleReconnect()
    })
    nextSocket.on('error', () => {
      if (
        nextSocket.readyState === WebSocket.CONNECTING ||
        nextSocket.readyState === WebSocket.OPEN
      ) {
        nextSocket.close()
      }
    })
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      connect()
    },
    stop() {
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = undefined
      }
      const current = socket
      socket = null
      current?.close()
    },
    queue
  }
}

function readToken(): string {
  if (HUB_TOKEN_FILE) return fs.readFileSync(HUB_TOKEN_FILE, 'utf8').trim()
  if (HUB_TOKEN) return HUB_TOKEN
  throw new Error('HUB_TOKEN or HUB_TOKEN_FILE is required')
}

const defaultAgent = createAgent({ hubUrl: HUB_URL, readToken })

export function startAgent(): void {
  defaultAgent.start()
}

const entrypoint = process.argv[1]
if (entrypoint && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) {
  startAgent()
}

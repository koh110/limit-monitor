import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer } from 'ws'
import {
  CONTROL_MAX_PAYLOAD_BYTES,
  controlMessageSchema,
  type ControlMessage
} from 'shared/src/control'
import { providerSchema } from 'shared/src/contracts'
import {
  claimQueuedRefresh,
  getRefresh,
  listQueuedRefreshes,
  releaseRefreshDispatch,
  requeueExpiredRefreshes,
  REFRESH_LEASE_TIMEOUT_MS,
  updateRefreshStatus
} from './refresh/store.js'
import { verifyToken } from '../features/tokens/store.js'
import type { Db } from '../lib/database.js'
import { createControlRegistry, createPeriodicScheduler } from './control.js'

type UpgradeServer = {
  on: (
    event: 'upgrade',
    listener: (request: IncomingMessage, socket: Socket, head: Buffer) => void
  ) => unknown
}

export function attachControlServer({
  server,
  db,
  intervalMs,
  leaseTimeoutMs = REFRESH_LEASE_TIMEOUT_MS,
  refreshLeaseIntervalMs = Math.min(intervalMs, leaseTimeoutMs),
  registry = createControlRegistry()
}: {
  server: UpgradeServer
  db: Db
  intervalMs: number
  leaseTimeoutMs?: number
  refreshLeaseIntervalMs?: number
  registry?: ReturnType<typeof createControlRegistry>
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: CONTROL_MAX_PAYLOAD_BYTES })
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      try {
        if (
          new URL(request.url ?? '/', 'http://localhost').pathname !== '/api/v1/collector/control'
        ) {
          socket.destroy()
          return
        }
        const authorization = request.headers.authorization
        const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
        const scope = token ? await verifyToken({ db, token }) : null
        if (!scope) {
          socket.destroy()
          return
        }
        wss.handleUpgrade(request, socket, head, (client) => {
          const send = (message: ControlMessage) => {
            if (client.readyState !== 1) return false
            try {
              client.send(JSON.stringify(message))
              return true
            } catch {
              return false
            }
          }
          const unregister = registry.register({ ...scope, send })
          client.on('error', () => {
            if (client.readyState !== client.CLOSED) client.terminate()
          })
          client.on('message', (raw) => {
            void (async () => {
              try {
                let value: unknown
                try {
                  value = JSON.parse(String(raw))
                } catch {
                  return
                }
                const parsed = controlMessageSchema.safeParse(value)
                if (!parsed.success) return
                if (parsed.data.type === 'heartbeat') {
                  if (client.readyState === client.OPEN) {
                    client.send(JSON.stringify(parsed.data), (error) => {
                      if (error) client.terminate()
                    })
                  }
                  return
                }
                if (parsed.data.type !== 'job_started' && parsed.data.type !== 'job_finished')
                  return
                const request = await getRefresh({ db, id: parsed.data.requestId })
                if (
                  !request ||
                  request.sourceId !== scope.sourceId ||
                  request.accountAlias !== scope.accountAlias
                ) {
                  return
                }
                if (parsed.data.type === 'job_started') {
                  await updateRefreshStatus({
                    db,
                    id: parsed.data.requestId,
                    leaseId: parsed.data.leaseId,
                    status: 'running',
                    now: new Date()
                  })
                } else {
                  await updateRefreshStatus({
                    db,
                    id: parsed.data.requestId,
                    leaseId: parsed.data.leaseId,
                    status: parsed.data.ok ? 'completed' : 'failed',
                    now: new Date(),
                    errorCode: parsed.data.ok ? undefined : 'worker_failed'
                  })
                }
              } catch {
                // malformed or stale job notifications must not terminate the agent session
              }
            })()
          })
          client.on('close', unregister)
          void dispatchQueued(db, scope, send)
        })
      } catch {
        socket.destroy()
      }
    })()
  })
  const scheduler = createPeriodicScheduler({
    intervalMs,
    dispatch: (message) => {
      // registry owns the authenticated sessions; generic trigger fanout is intentionally provider-blind
      for (const session of registry.sessions()) session.send(message)
    }
  })
  scheduler.start()
  const leaseTimer = setInterval(() => {
    void dispatchExpiredLeases({ db, registry, leaseTimeoutMs }).catch(() => {
      // lease再配送の一時的なDB失敗は次のtickで再試行する
    })
  }, refreshLeaseIntervalMs)
  return {
    registry,
    scheduler,
    close: () => {
      scheduler.stop()
      clearInterval(leaseTimer)
      // 既存接続は wss.close() だけでは process を alive に保ち続けるため、
      // シャットダウン時に全クライアントを強制切断する
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
    }
  }
}

async function dispatchExpiredLeases({
  db,
  registry,
  leaseTimeoutMs
}: {
  db: Db
  registry: ReturnType<typeof createControlRegistry>
  leaseTimeoutMs: number
}) {
  await requeueExpiredRefreshes({ db, now: new Date(), leaseTimeoutMs })
  for (const session of registry.sessions()) {
    await dispatchQueued(
      db,
      { sourceId: session.sourceId, accountAlias: session.accountAlias },
      session.send,
      leaseTimeoutMs,
      false
    )
  }
}

export async function dispatchQueued(
  db: Db,
  scope: { sourceId: string; accountAlias: string },
  send: (message: ControlMessage) => boolean,
  leaseTimeoutMs = REFRESH_LEASE_TIMEOUT_MS,
  requeue = true
) {
  if (requeue) await requeueExpiredRefreshes({ db, now: new Date(), leaseTimeoutMs })
  const requests = await listQueuedRefreshes({ db, ...scope })
  for (const request of requests) {
    const provider = providerSchema.safeParse(request.provider)
    if (!provider.success) continue
    const claim = await claimQueuedRefresh({ db, id: request.id, now: new Date() })
    if (!claim) continue
    let sent = false
    try {
      sent = send({
        type: 'refresh',
        requestId: claim.id,
        leaseId: claim.leaseId,
        provider: provider.data
      })
    } catch {
      sent = false
    }
    if (!sent) {
      await releaseRefreshDispatch({
        db,
        id: claim.id,
        dispatchedAt: claim.dispatchedAt,
        leaseId: claim.leaseId
      })
    }
  }
}

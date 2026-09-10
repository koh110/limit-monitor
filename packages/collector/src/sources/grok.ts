import { spawn } from 'node:child_process'
import { buildGrokObservation } from '../adapters/grok.js'
import { createLineDecoder } from '../lib/line-decoder.js'
import type { ProviderReadInput, ProviderReadResult } from './types.js'

export const GROK_AGENT_ARGS = ['agent', 'stdio'] as const
export const GROK_INITIALIZE_ID = 1
export const GROK_BILLING_ID = 2
const KILL_GRACE_MS = 2000

export type GrokSourceOptions = {
  command: string
  timeoutMs: number
  maxStdoutBytes: number
}

type GrokAgentOutcome =
  | { ok: true; result: unknown }
  | { ok: false; reason: string; detail: string }

type JsonRpcMessage = {
  id?: unknown
  result?: unknown
  error?: unknown
}

export function buildGrokInitializeRequest(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: GROK_INITIALIZE_ID,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {}
    }
  })
}

/** ACP extension methods are prefixed with `_` on the JSON-RPC wire. */
export function buildGrokBillingRequest(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: GROK_BILLING_ID,
    method: '_x.ai/billing',
    params: {}
  })
}

function parseMessage(line: string): JsonRpcMessage | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? (parsed as JsonRpcMessage) : null
  } catch {
    return null
  }
}

function errorDetail(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'unknown ACP error'
  }
  const value = error as { code?: unknown; message?: unknown }
  const code = typeof value.code === 'number' ? value.code : 'unknown'
  const message = typeof value.message === 'string' ? value.message : 'unknown error'
  return `ACP error code=${code}: ${message}`
}

/**
 * `grok agent stdio` を起動し、ACP の app-level `x.ai/billing` を 1 回呼ぶ。
 * セッションや prompt は作らず、認証済み Grok Build アカウントの allowance だけを読む。
 */
function readAgentBilling(options: GrokSourceOptions): Promise<GrokAgentOutcome> {
  return new Promise<GrokAgentOutcome>((resolve) => {
    const child = spawn(options.command, [...GROK_AGENT_ARGS], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const decoder = createLineDecoder({ maxBufferBytes: options.maxStdoutBytes })
    let stdoutBytes = 0
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    const timeoutTimer = setTimeout(() => {
      finish({
        ok: false,
        reason: 'timeout',
        detail: `grok agent stdio timed out after ${options.timeoutMs}ms`
      })
    }, options.timeoutMs)

    function terminate() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
      }, KILL_GRACE_MS)
      killTimer.unref()
    }

    function finish(outcome: GrokAgentOutcome) {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeoutTimer)
      terminate()
      resolve(outcome)
    }

    function write(line: string) {
      if (!child.stdin.destroyed) {
        child.stdin.write(`${line}\n`)
      }
    }

    child.on('error', (error: Error) => {
      finish({
        ok: false,
        reason: 'spawn_failed',
        detail: `failed to spawn "${options.command}": ${error.message}`
      })
    })
    child.stdin.on('error', () => {})
    child.stderr.resume()

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > options.maxStdoutBytes) {
        finish({
          ok: false,
          reason: 'stdout_limit_exceeded',
          detail: `grok agent stdio stdout exceeded ${options.maxStdoutBytes} bytes`
        })
        return
      }
      const decoded = decoder.push(chunk)
      if (!decoded.ok) {
        finish({ ok: false, reason: decoded.reason, detail: decoded.detail })
        return
      }
      for (const line of decoded.lines) {
        const message = parseMessage(line)
        if (!message) {
          continue
        }
        if (message.id === GROK_INITIALIZE_ID) {
          if (message.error !== undefined) {
            finish({ ok: false, reason: 'agent_error', detail: errorDetail(message.error) })
            return
          }
          write(buildGrokBillingRequest())
          continue
        }
        if (message.id === GROK_BILLING_ID) {
          if (message.error !== undefined) {
            finish({ ok: false, reason: 'billing_error', detail: errorDetail(message.error) })
            return
          }
          if (!('result' in message)) {
            finish({ ok: false, reason: 'invalid_response', detail: 'grok billing response had no result' })
            return
          }
          finish({ ok: true, result: message.result })
          return
        }
      }
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (killTimer) {
        clearTimeout(killTimer)
      }
      finish({
        ok: false,
        reason: 'exit_failure',
        detail: `grok agent stdio exited before responding code=${code ?? 'null'} signal=${signal ?? 'null'}`
      })
    })

    write(buildGrokInitializeRequest())
  })
}

export function createGrokReader(options: GrokSourceOptions) {
  return async ({ sourceId, observedAt }: ProviderReadInput): Promise<ProviderReadResult> => {
    const outcome = await readAgentBilling(options)
    if (!outcome.ok) {
      return outcome
    }
    const observation = buildGrokObservation({ payload: outcome.result, sourceId, observedAt })
    if (!observation) {
      return {
        ok: false,
        reason: 'no_rate_limits',
        detail: 'grok billing response contained no usable allowance'
      }
    }
    return { ok: true, observation }
  }
}

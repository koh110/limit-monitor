import { spawn } from 'node:child_process'
import { buildGrokObservation } from '../adapters/grok.js'
import { createLineDecoder } from '../lib/line-decoder.js'
import {
  GROK_AGENT_ARGS,
  GROK_BILLING_ID,
  GROK_INITIALIZE_ID,
  buildGrokBillingRequest,
  buildGrokInitializeRequest,
  parseGrokMessage
} from './grok-protocol.js'
import type { ProviderReadInput, ProviderReadResult } from './types.js'

const KILL_GRACE_MS = 2000

export type GrokSourceOptions = {
  command: string
  timeoutMs: number
  maxStdoutBytes: number
}

type GrokAgentOutcome =
  | { ok: true; result: unknown }
  | { ok: false; reason: string; detail: string }

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
      if (child.stdin.destroyed) {
        return
      }
      child.stdin.write(`${line}\n`)
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
        const message = parseGrokMessage(line)
        if (message.kind === 'error') {
          if (message.id === GROK_INITIALIZE_ID || message.id === GROK_BILLING_ID) {
            finish({
              ok: false,
              reason: message.id === GROK_INITIALIZE_ID ? 'agent_error' : 'billing_error',
              detail: `grok ACP error id=${message.id} code=${message.code ?? 'null'}: ${message.message}`
            })
            return
          }
          continue
        }
        if (message.kind !== 'result') {
          continue
        }
        if (message.id === GROK_INITIALIZE_ID) {
          write(buildGrokBillingRequest())
          continue
        }
        if (message.id === GROK_BILLING_ID) {
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
      return { ok: false, reason: outcome.reason, detail: outcome.detail }
    }
    const observation = buildGrokObservation({
      payload: outcome.result,
      sourceId,
      observedAt
    })
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

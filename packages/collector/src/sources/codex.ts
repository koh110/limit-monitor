import { spawn } from 'node:child_process'
import { buildCodexObservation } from '../adapters/codex.js'
import { createLineDecoder } from '../lib/line-decoder.js'
import {
  CODEX_APP_SERVER_ARGS,
  CODEX_INITIALIZE_ID,
  CODEX_RATE_LIMITS_ID,
  buildCodexInitializedNotification,
  buildCodexInitializeRequest,
  buildCodexRateLimitsRequest,
  parseCodexMessage,
  parseCodexRateLimitsResult
} from './codex-protocol.js'
import type { ProviderReadInput, ProviderReadResult } from './types.js'

const CLIENT_NAME = 'limit-monitor-collector'
const KILL_GRACE_MS = 2000

export type CodexSourceOptions = {
  command: string
  timeoutMs: number
  maxStdoutBytes: number
  clientVersion: string
}

type AppServerOutcome =
  | { ok: true; result: unknown }
  | { ok: false; reason: string; detail: string }

/**
 * `codex app-server` を stdio で起動し `account/rateLimits/read` を 1 回呼ぶ。
 * 有限 timeout・stdout 上限を持ち、応答が得られたら即座に子プロセスを終了させる。
 * 応答本文はログへ出さない。
 */
function readAppServerRateLimits(options: CodexSourceOptions): Promise<AppServerOutcome> {
  return new Promise<AppServerOutcome>((resolve) => {
    const child = spawn(options.command, [...CODEX_APP_SERVER_ARGS], {
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
        detail: `codex app-server timed out after ${options.timeoutMs}ms`
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

    function finish(outcome: AppServerOutcome) {
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

    // stdin が先に閉じられた場合の EPIPE で落とさない
    child.stdin.on('error', () => {})

    // app-server は sandbox 警告などを stderr へ書く。内容は保持しない
    child.stderr.resume()

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > options.maxStdoutBytes) {
        finish({
          ok: false,
          reason: 'stdout_limit_exceeded',
          detail: `codex app-server stdout exceeded ${options.maxStdoutBytes} bytes`
        })
        return
      }
      const decoded = decoder.push(chunk)
      if (!decoded.ok) {
        finish({ ok: false, reason: decoded.reason, detail: decoded.detail })
        return
      }
      for (const line of decoded.lines) {
        const message = parseCodexMessage(line)
        if (message.kind === 'error') {
          if (message.id === CODEX_INITIALIZE_ID || message.id === CODEX_RATE_LIMITS_ID) {
            finish({
              ok: false,
              reason: 'app_server_error',
              detail: `app-server error id=${message.id} code=${message.code ?? 'null'}: ${message.message}`
            })
            return
          }
          continue
        }
        if (message.kind !== 'result') {
          continue
        }
        if (message.id === CODEX_INITIALIZE_ID) {
          write(buildCodexInitializedNotification())
          write(buildCodexRateLimitsRequest())
          continue
        }
        if (message.id === CODEX_RATE_LIMITS_ID) {
          finish({ ok: true, result: message.result })
          return
        }
      }
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (killTimer) {
        clearTimeout(killTimer)
      }
      // 応答前に終了したら失敗(未認証・起動失敗など)
      finish({
        ok: false,
        reason: 'exit_failure',
        detail: `codex app-server exited before responding code=${code ?? 'null'} signal=${signal ?? 'null'}`
      })
    })

    write(
      buildCodexInitializeRequest({
        clientName: CLIENT_NAME,
        clientVersion: options.clientVersion
      })
    )
  })
}

export function createCodexReader(options: CodexSourceOptions) {
  return async ({ sourceId, observedAt }: ProviderReadInput): Promise<ProviderReadResult> => {
    const outcome = await readAppServerRateLimits(options)
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason, detail: outcome.detail }
    }
    const parsed = parseCodexRateLimitsResult(outcome.result)
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason, detail: parsed.detail }
    }
    const observation = buildCodexObservation({
      payload: parsed.payload,
      sourceId,
      observedAt
    })
    if (!observation) {
      return {
        ok: false,
        reason: 'no_rate_limits',
        detail: 'codex rate limits contained no usable window'
      }
    }
    return { ok: true, observation }
  }
}

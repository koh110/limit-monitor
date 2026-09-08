import fs from 'node:fs'
import type { ProviderOutcome, ProviderReaders } from './collect.js'
import { collectObservations, selectReaders } from './collect.js'
import {
  CLAUDE_BIN,
  CODEX_BIN,
  COLLECTOR_MODE,
  COLLECTOR_VERSION,
  COMMAND_TIMEOUT_MS,
  HUB_TOKEN,
  HUB_TOKEN_FILE,
  HUB_URL,
  INTERVAL_SECONDS,
  MAX_STDOUT_BYTES,
  PROVIDERS,
  SEND_TIMEOUT_MS,
  SOURCE_ID
} from './config.js'
import { createCycleLoop } from './loop.js'
import { logger } from './lib/logger.js'
import { judgeStartupCycle } from './outcome.js'
import { sendObservation } from './send.js'
import { createClaudeReader } from './sources/claude.js'
import { createCodexReader } from './sources/codex.js'

function readToken(): string {
  // 運用は systemd LoadCredential で注入した file を優先する(仕様 12.3)
  if (HUB_TOKEN_FILE) {
    return fs.readFileSync(HUB_TOKEN_FILE, 'utf8').trim()
  }
  if (HUB_TOKEN) {
    return HUB_TOKEN
  }
  throw new Error('HUB_TOKEN or HUB_TOKEN_FILE is required')
}

/** real mode の reader。手元にインストールされた各 CLI から実値を取得する */
function createRealReaders(): ProviderReaders {
  return {
    codex: createCodexReader({
      command: CODEX_BIN,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxStdoutBytes: MAX_STDOUT_BYTES,
      clientVersion: COLLECTOR_VERSION
    }),
    claude: createClaudeReader({
      command: CLAUDE_BIN,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxStdoutBytes: MAX_STDOUT_BYTES
    })
  }
}

/**
 * 収集して送信し、provider 単位の最終結果を返す。
 * 収集できなかった provider には何も送らないため Hub の古い値は保持される。
 */
async function collectAndSend(token: string): Promise<ProviderOutcome[]> {
  const observedAt = new Date().toISOString()
  const readers = selectReaders({ mode: COLLECTOR_MODE, realReaders: createRealReaders() })
  const collected = await collectObservations({
    providers: PROVIDERS,
    readers,
    sourceId: SOURCE_ID,
    observedAt
  })

  const outcomes: ProviderOutcome[] = []
  for (const outcome of collected) {
    if (!outcome.ok) {
      logger.error({
        label: 'collect failed',
        body: `${outcome.provider} observation not collected`,
        meta: { provider: outcome.provider, reason: outcome.reason, detail: outcome.detail }
      })
      outcomes.push(outcome)
      continue
    }
    const result = await sendObservation({
      hubUrl: HUB_URL,
      token,
      observation: outcome.observation,
      timeoutMs: SEND_TIMEOUT_MS
    })
    if (result.ok) {
      logger.log({
        label: 'sent',
        body: `${outcome.provider} observation sent`,
        meta: {
          provider: outcome.provider,
          accepted: result.body.accepted,
          skipped: result.body.skipped,
          rejected: result.body.rejected
        }
      })
      outcomes.push(outcome)
      continue
    }
    logger.error({
      label: 'send failed',
      body: `${outcome.provider} observation failed`,
      meta: { provider: outcome.provider, status: result.status, detail: result.body }
    })
    // 送信できなければそのサイクルは成功していない
    outcomes.push({
      provider: outcome.provider,
      ok: false,
      reason: 'send_failed',
      detail: `hub responded with status ${result.status}`
    })
  }
  return outcomes
}

async function main() {
  const token = readToken()
  logger.log({
    label: 'collector started',
    body: `collector sending to ${HUB_URL}`,
    meta: {
      mode: COLLECTOR_MODE,
      sourceId: SOURCE_ID,
      providers: PROVIDERS,
      intervalSeconds: INTERVAL_SECONDS
    }
  })

  const isOneshot = INTERVAL_SECONDS === 0
  const outcomes = await collectAndSend(token)
  const verdict = judgeStartupCycle({ outcomes, isOneshot })
  if (verdict.exitCode !== 0) {
    process.exitCode = verdict.exitCode
    const failed = outcomes
      .filter((outcome) => {
        return !outcome.ok
      })
      .map((outcome) => {
        return outcome.provider
      })
    logger.error({
      label: 'startup cycle failed',
      body: `${failed.length}/${outcomes.length} provider(s) were not collected and sent`,
      meta: { mode: COLLECTOR_MODE, failed, total: outcomes.length }
    })
  }
  if (!verdict.continueRunning) {
    return
  }

  // 非重複 loop: 前 cycle 完了後に次 cycle を schedule する。
  // setInterval のように実行が interval を超えても重ねて起動しない。
  const loop = createCycleLoop({
    intervalMs: INTERVAL_SECONDS * 1000,
    runCycle: async () => {
      await collectAndSend(token).catch((error: unknown) => {
        logger.error({ label: 'collect failed', body: 'unexpected', error })
      })
    }
  })
  process.on('SIGTERM', () => {
    loop.stop()
  })
  process.on('SIGINT', () => {
    loop.stop()
  })
}

main().catch((error: unknown) => {
  logger.error({ label: 'collector error', body: 'failed to start', error })
  process.exitCode = 1
})

import fs from 'node:fs'
import type { Observation } from 'shared/src/contracts'
import { buildClaudeObservation } from './adapters/claude.js'
import { buildCodexObservation } from './adapters/codex.js'
import {
  HUB_TOKEN,
  HUB_TOKEN_FILE,
  HUB_URL,
  INTERVAL_SECONDS,
  PROVIDERS,
  SOURCE_ID
} from './config.js'
import { createClaudeFixture } from './fixtures/claude.js'
import { createCodexFixture } from './fixtures/codex.js'
import { logger } from './lib/logger.js'
import { sendObservation } from './send.js'

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

// Phase 1 の mock collector: vendor fixture を正規化して Hub へ送信する
function buildObservations(now: Date): Observation[] {
  const observedAt = now.toISOString()
  const observations: Observation[] = []
  if (PROVIDERS.includes('codex')) {
    const observation = buildCodexObservation({
      payload: createCodexFixture(now),
      sourceId: SOURCE_ID,
      observedAt
    })
    if (observation) {
      observations.push(observation)
    }
  }
  if (PROVIDERS.includes('claude')) {
    const observation = buildClaudeObservation({
      statusLine: createClaudeFixture(now),
      sourceId: SOURCE_ID,
      observedAt
    })
    if (observation) {
      observations.push(observation)
    }
  }
  return observations
}

async function collectAndSend(token: string) {
  for (const observation of buildObservations(new Date())) {
    const result = await sendObservation({
      hubUrl: HUB_URL,
      token,
      observation
    })
    if (result.ok) {
      logger.log({
        label: 'sent',
        body: `${observation.provider} observation sent`,
        meta: {
          provider: observation.provider,
          accepted: result.body.accepted,
          skipped: result.body.skipped,
          rejected: result.body.rejected
        }
      })
    } else {
      logger.error({
        label: 'send failed',
        body: `${observation.provider} observation failed`,
        meta: { status: result.status, detail: result.body }
      })
    }
  }
}

async function main() {
  const token = readToken()
  logger.log({
    label: 'collector started',
    body: `mock collector sending to ${HUB_URL}`,
    meta: {
      sourceId: SOURCE_ID,
      providers: PROVIDERS,
      intervalSeconds: INTERVAL_SECONDS
    }
  })
  await collectAndSend(token)
  if (INTERVAL_SECONDS > 0) {
    setInterval(() => {
      collectAndSend(token).catch((error: unknown) => {
        logger.error({ label: 'collect failed', body: 'unexpected', error })
      })
    }, INTERVAL_SECONDS * 1000)
  }
}

main().catch((error: unknown) => {
  logger.error({ label: 'collector error', body: 'failed to start', error })
  process.exitCode = 1
})

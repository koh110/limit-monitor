import type { Provider } from 'shared/src/contracts'
import { buildClaudeObservation } from './adapters/claude.js'
import { buildCodexObservation } from './adapters/codex.js'
import { buildGrokObservation } from './adapters/grok.js'
import type { CollectorMode } from './config.js'
import { createClaudeFixture } from './fixtures/claude.js'
import { createCodexFixture } from './fixtures/codex.js'
import { createGrokFixture } from './fixtures/grok.js'
import type { ProviderReadResult, ProviderReader } from './sources/types.js'

export type ProviderOutcome = { provider: Provider } & ProviderReadResult

export type ProviderReaders = Record<Provider, ProviderReader>

/**
 * mock mode 用の reader。fixture は `COLLECTOR_MODE=mock` を明示した場合のみ
 * 使われ、real mode では絶対に経由しない。
 */
export function createFixtureReaders(): ProviderReaders {
  return {
    codex: async ({ sourceId, observedAt }) => {
      const observation = buildCodexObservation({
        payload: createCodexFixture(new Date(observedAt)),
        sourceId,
        observedAt
      })
      return observation
        ? { ok: true, observation }
        : { ok: false, reason: 'no_rate_limits', detail: 'codex fixture produced no bucket' }
    },
    claude: async ({ sourceId, observedAt }) => {
      const observation = buildClaudeObservation({
        statusLine: createClaudeFixture(new Date(observedAt)),
        sourceId,
        observedAt
      })
      return observation
        ? { ok: true, observation }
        : { ok: false, reason: 'no_rate_limits', detail: 'claude fixture produced no bucket' }
    },
    grok: async ({ sourceId, observedAt }) => {
      const observation = buildGrokObservation({
        payload: createGrokFixture(new Date(observedAt)),
        sourceId,
        observedAt
      })
      return observation
        ? { ok: true, observation }
        : { ok: false, reason: 'no_rate_limits', detail: 'grok fixture produced no bucket' }
    }
  }
}

/**
 * 設定された provider を順に収集する。1 つの provider の失敗が他を止めない。
 * 失敗した provider については何も送らないため、Hub 側の古い値は消えない。
 */
export async function collectObservations({
  providers,
  readers,
  sourceId,
  observedAt
}: {
  providers: readonly Provider[]
  readers: ProviderReaders
  sourceId: string
  observedAt: string
}): Promise<ProviderOutcome[]> {
  const outcomes: ProviderOutcome[] = []
  for (const provider of providers) {
    const reader = readers[provider]
    try {
      const result = await reader({ sourceId, observedAt })
      outcomes.push({ provider, ...result })
    } catch (error) {
      outcomes.push({
        provider,
        ok: false,
        reason: 'reader_threw',
        detail: error instanceof Error ? error.message : 'unknown reader error'
      })
    }
  }
  return outcomes
}

/** mode に応じた reader 一式を選ぶ。real mode の reader は呼び出し側が組み立てる */
export function selectReaders({
  mode,
  realReaders
}: {
  mode: CollectorMode
  realReaders: ProviderReaders
}): ProviderReaders {
  return mode === 'mock' ? createFixtureReaders() : realReaders
}

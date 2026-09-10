import { expect, test } from 'vite-plus/test'
import type { Observation } from 'shared/src/contracts'
import { collectObservations, createFixtureReaders, selectReaders } from './collect.js'
import type { ProviderReaders } from './collect.js'

const OBSERVED_AT = '2026-09-01T11:36:47.683Z'

function observation(provider: 'codex' | 'claude'): Observation {
  return {
    schemaVersion: 1,
    provider,
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT,
    buckets: [
      {
        bucketId: `${provider}:x`,
        label: '5h',
        usedPercent: 1,
        remainingPercent: 99,
        windowDurationSeconds: 18000,
        resetsAt: null,
        reached: false
      }
    ]
  }
}

function stubReaders({
  codexOk,
  claudeOk
}: {
  codexOk: boolean
  claudeOk: boolean
}): ProviderReaders {
  return {
    codex: async () => {
      return codexOk
        ? { ok: true, observation: observation('codex') }
        : { ok: false, reason: 'spawn_failed', detail: 'codex missing' }
    },
    claude: async () => {
      return claudeOk
        ? { ok: true, observation: observation('claude') }
        : { ok: false, reason: 'timeout', detail: 'claude timed out' }
    }
  }
}

test('real mode は real reader を使い fixture へ落ちない', async () => {
  const realReaders = stubReaders({ codexOk: true, claudeOk: true })
  expect(selectReaders({ mode: 'real', realReaders })).toBe(realReaders)
})

test('mock mode だけが fixture reader を使う', async () => {
  const realReaders = stubReaders({ codexOk: true, claudeOk: true })
  const readers = selectReaders({ mode: 'mock', realReaders })
  expect(readers).not.toBe(realReaders)
  const result = await readers.codex({ sourceId: 'dev-machine', observedAt: OBSERVED_AT })
  expect(result.ok).toBe(true)
})

test('fixture reader は codex / claude 両方の観測を作る', async () => {
  const readers = createFixtureReaders()
  const outcomes = await collectObservations({
    providers: ['codex', 'claude'],
    readers,
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })
  expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true])
  expect(outcomes.map((outcome) => outcome.provider)).toEqual(['codex', 'claude'])
})

test('provider 単位で失敗が独立し、他 provider を止めない', async () => {
  const outcomes = await collectObservations({
    providers: ['codex', 'claude'],
    readers: stubReaders({ codexOk: false, claudeOk: true }),
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })
  expect(outcomes[0]).toMatchObject({ provider: 'codex', ok: false, reason: 'spawn_failed' })
  expect(outcomes[1]).toMatchObject({ provider: 'claude', ok: true })
})

test('失敗した provider の Observation は作られない(Hub の古い値を消さない)', async () => {
  const outcomes = await collectObservations({
    providers: ['codex'],
    readers: stubReaders({ codexOk: false, claudeOk: true }),
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })
  expect(outcomes.length).toBe(1)
  expect(outcomes[0]?.ok).toBe(false)
  expect(outcomes[0] && 'observation' in outcomes[0]).toBe(false)
})

test('reader が throw しても outcome として回収する', async () => {
  const readers: ProviderReaders = {
    codex: async () => {
      throw new Error('boom')
    },
    claude: async () => {
      return { ok: true, observation: observation('claude') }
    }
  }
  const outcomes = await collectObservations({
    providers: ['codex', 'claude'],
    readers,
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })
  expect(outcomes[0]).toMatchObject({ ok: false, reason: 'reader_threw', detail: 'boom' })
  expect(outcomes[1]?.ok).toBe(true)
})

test('指定した provider だけを収集する', async () => {
  const outcomes = await collectObservations({
    providers: ['claude'],
    readers: stubReaders({ codexOk: true, claudeOk: true }),
    sourceId: 'dev-machine',
    observedAt: OBSERVED_AT
  })
  expect(outcomes.map((outcome) => outcome.provider)).toEqual(['claude'])
})

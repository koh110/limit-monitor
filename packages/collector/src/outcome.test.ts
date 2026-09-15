import { expect, test } from 'vite-plus/test'
import type { ProviderOutcome } from './collect.js'
import { judgeStartupCycle } from './outcome.js'

const ok: ProviderOutcome = {
  provider: 'codex',
  ok: true,
  observation: {
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
}

const failed: ProviderOutcome = {
  provider: 'claude',
  ok: false,
  reason: 'spawn_failed',
  detail: 'claude not installed'
}

test('provider が 1 つも無ければ設定不備として失敗させる', () => {
  expect(judgeStartupCycle({ outcomes: [] })).toEqual({ exitCode: 1 })
})

test('全 provider 失敗は非 0 終了にする', () => {
  expect(judgeStartupCycle({ outcomes: [failed] })).toEqual({ exitCode: 1 })
})

test('一部 provider の失敗も非 0 終了にする', () => {
  expect(judgeStartupCycle({ outcomes: [ok, failed] })).toEqual({ exitCode: 1 })
})

test('全て成功なら 0 終了にする', () => {
  expect(judgeStartupCycle({ outcomes: [ok] })).toEqual({ exitCode: 0 })
})

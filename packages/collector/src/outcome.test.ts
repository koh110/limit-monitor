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
  expect(judgeStartupCycle({ outcomes: [], isOneshot: true })).toEqual({
    exitCode: 1,
    continueRunning: false
  })
  expect(judgeStartupCycle({ outcomes: [], isOneshot: false })).toEqual({
    exitCode: 1,
    continueRunning: false
  })
})

test('全 provider 失敗は常駐でも起動失敗にする(無条件の成功扱いをしない)', () => {
  expect(judgeStartupCycle({ outcomes: [failed], isOneshot: false })).toEqual({
    exitCode: 1,
    continueRunning: false
  })
  expect(judgeStartupCycle({ outcomes: [failed], isOneshot: true })).toEqual({
    exitCode: 1,
    continueRunning: false
  })
})

test('oneshot で一部失敗なら非 0 終了にする', () => {
  expect(judgeStartupCycle({ outcomes: [ok, failed], isOneshot: true })).toEqual({
    exitCode: 1,
    continueRunning: false
  })
})

test('常駐で一部失敗なら常駐は継続する(一時障害で落とさない)', () => {
  expect(judgeStartupCycle({ outcomes: [ok, failed], isOneshot: false })).toEqual({
    exitCode: 0,
    continueRunning: true
  })
})

test('全て成功なら oneshot は終了し常駐は継続する', () => {
  expect(judgeStartupCycle({ outcomes: [ok], isOneshot: true })).toEqual({
    exitCode: 0,
    continueRunning: false
  })
  expect(judgeStartupCycle({ outcomes: [ok], isOneshot: false })).toEqual({
    exitCode: 0,
    continueRunning: true
  })
})

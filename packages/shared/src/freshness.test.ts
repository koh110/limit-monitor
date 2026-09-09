import { expect, test } from 'vite-plus/test'
import { FRESHNESS_THRESHOLDS, computeFreshness } from './freshness.js'

const now = new Date('2026-08-23T12:00:00.000Z')

test('観測なし(null)は never', () => {
  expect(computeFreshness(null, now)).toBe('never')
})

test('観測時刻が parse 不能な場合は never', () => {
  expect(computeFreshness('not-a-date', now)).toBe('never')
})

test('10分未満は fresh', () => {
  expect(computeFreshness('2026-08-23T11:59:59.000Z', now)).toBe('fresh')
  expect(computeFreshness('2026-08-23T11:50:00.001Z', now)).toBe('fresh')
})

test('ちょうど10分で stale になる', () => {
  expect(computeFreshness('2026-08-23T11:50:00.000Z', now)).toBe('stale')
})

test('24時間未満は stale', () => {
  expect(computeFreshness('2026-08-22T12:00:00.001Z', now)).toBe('stale')
})

test('24時間以上は expired', () => {
  expect(computeFreshness('2026-08-22T12:00:00.000Z', now)).toBe('expired')
  expect(computeFreshness('2026-08-01T00:00:00.000Z', now)).toBe('expired')
})

test('clock skew で未来の観測時刻は fresh として扱う', () => {
  expect(computeFreshness('2026-08-23T12:03:00.000Z', now)).toBe('fresh')
})

test('閾値定数は仕様の 10分 / 24時間', () => {
  expect(FRESHNESS_THRESHOLDS.staleAfterMs).toBe(600000)
  expect(FRESHNESS_THRESHOLDS.expiredAfterMs).toBe(86400000)
})

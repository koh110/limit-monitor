import { expect, test } from 'vite-plus/test'
import { formatAgo, formatDuration, formatJst, formatUntilReset } from './format'

const now = new Date('2026-08-23T04:00:00.000Z')

test('formatJst は Asia/Tokyo で MM/DD HH:mm を返す', () => {
  expect(formatJst('2026-08-23T04:00:00.000Z')).toBe('08/23 13:00')
  expect(formatJst('2026-08-22T15:00:00.000Z')).toBe('08/23 00:00')
})

test('formatJst は null / 不正な日時を -- にする', () => {
  expect(formatJst(null)).toBe('--')
  expect(formatJst('not-a-date')).toBe('--')
})

test('formatDuration は 2h14m 形式で丸める', () => {
  expect(formatDuration(0)).toBe('0m')
  expect(formatDuration(59_000)).toBe('0m')
  expect(formatDuration(60_000)).toBe('1m')
  expect(formatDuration((2 * 60 + 14) * 60_000)).toBe('2h14m')
  expect(formatDuration(3 * 24 * 60 * 60_000)).toBe('3d0h')
  expect(formatDuration(-1)).toBe('0m')
})

test('formatUntilReset はリセットまでの相対時間を返す', () => {
  expect(formatUntilReset('2026-08-23T06:14:00.000Z', now)).toBe('あと2h14m')
  expect(formatUntilReset('2026-08-23T04:00:00.000Z', now)).toBe('リセット済み')
  expect(formatUntilReset('2026-08-23T03:00:00.000Z', now)).toBe('リセット済み')
  expect(formatUntilReset(null, now)).toBe('--')
  expect(formatUntilReset('broken', now)).toBe('--')
})

test('formatAgo は最終観測からの経過時間を返す', () => {
  expect(formatAgo('2026-08-23T03:59:30.000Z', now)).toBe('たった今')
  expect(formatAgo('2026-08-23T03:45:00.000Z', now)).toBe('15m前')
  expect(formatAgo('2026-08-22T04:00:00.000Z', now)).toBe('1d0h前')
  expect(formatAgo('broken', now)).toBe('--')
})

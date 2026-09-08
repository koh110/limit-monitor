import { expect, test } from 'vite-plus/test'
import { normalizeEpochOrIso } from './normalize-time.js'

test('unix 秒を ISO 文字列へ変換する', () => {
  // 実測の codex app-server が返す形式
  expect(normalizeEpochOrIso(1788274954)).toBe('2026-09-01T15:02:34.000Z')
})

test('ISO 文字列は canonical な UTC ISO へ正規化する', () => {
  expect(normalizeEpochOrIso('2026-08-23T05:30:00.000Z')).toBe('2026-08-23T05:30:00.000Z')
  expect(normalizeEpochOrIso('2026-08-23T14:30:00+09:00')).toBe('2026-08-23T05:30:00.000Z')
})

test('null / undefined / 空文字は null を返す', () => {
  expect(normalizeEpochOrIso(null)).toBe(null)
  expect(normalizeEpochOrIso(undefined)).toBe(null)
  expect(normalizeEpochOrIso('   ')).toBe(null)
})

test('解釈できない値や範囲外の値は null を返す', () => {
  expect(normalizeEpochOrIso('not a date')).toBe(null)
  expect(normalizeEpochOrIso(Number.NaN)).toBe(null)
  expect(normalizeEpochOrIso(Number.POSITIVE_INFINITY)).toBe(null)
  // ミリ秒を秒として誤読した場合の巨大値
  expect(normalizeEpochOrIso(1788274954000)).toBe(null)
  expect(normalizeEpochOrIso(0)).toBe(null)
})

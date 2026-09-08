import { expect, test } from 'vite-plus/test'
import { zonedWallTimeOf, zonedWallTimeToUtc } from './zoned-time.js'

test('instant を timezone のローカル壁時計時刻へ変換する', () => {
  expect(
    zonedWallTimeOf({ date: new Date('2026-09-01T11:36:47.000Z'), timeZone: 'Asia/Tokyo' })
  ).toEqual({ year: 2026, month: 9, day: 1, hour: 20, minute: 36, second: 47 })
})

test('ローカル壁時計時刻を UTC instant へ変換する(固定 offset)', () => {
  const result = zonedWallTimeToUtc({
    wallTime: { year: 2026, month: 9, day: 1, hour: 21, minute: 19 },
    timeZone: 'Asia/Tokyo'
  })
  expect(result?.toISOString()).toBe('2026-09-01T12:19:00.000Z')
})

test('DST のある timezone でも正しい offset を選ぶ', () => {
  // 夏(EDT = UTC-4)
  expect(
    zonedWallTimeToUtc({
      wallTime: { year: 2026, month: 7, day: 1, hour: 12, minute: 0 },
      timeZone: 'America/New_York'
    })?.toISOString()
  ).toBe('2026-07-01T16:00:00.000Z')
  // 冬(EST = UTC-5)
  expect(
    zonedWallTimeToUtc({
      wallTime: { year: 2026, month: 1, day: 1, hour: 12, minute: 0 },
      timeZone: 'America/New_York'
    })?.toISOString()
  ).toBe('2026-01-01T17:00:00.000Z')
})

test('DST で存在しない時刻は null を返す', () => {
  // 2026-03-08 02:30 America/New_York は spring forward で存在しない
  expect(
    zonedWallTimeToUtc({
      wallTime: { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      timeZone: 'America/New_York'
    })
  ).toBe(null)
})

test('存在しない日付は null を返す', () => {
  expect(
    zonedWallTimeToUtc({
      wallTime: { year: 2026, month: 2, day: 30, hour: 12, minute: 0 },
      timeZone: 'Asia/Tokyo'
    })
  ).toBe(null)
})

test('未知の timezone 名は null を返す', () => {
  expect(zonedWallTimeOf({ date: new Date(), timeZone: 'Not/AZone' })).toBe(null)
  expect(
    zonedWallTimeToUtc({
      wallTime: { year: 2026, month: 9, day: 1, hour: 12, minute: 0 },
      timeZone: 'Not/AZone'
    })
  ).toBe(null)
})

test('UTC の深夜 0 時を扱える', () => {
  expect(
    zonedWallTimeToUtc({
      wallTime: { year: 2026, month: 1, day: 1, hour: 0, minute: 0 },
      timeZone: 'UTC'
    })?.toISOString()
  ).toBe('2026-01-01T00:00:00.000Z')
})

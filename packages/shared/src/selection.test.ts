import { expect, test } from 'vite-plus/test'
import { shouldReplaceLatest } from './selection.js'

const existing = {
  observedAt: '2026-08-23T04:00:00.000Z',
  receivedAt: '2026-08-23T04:00:05.000Z'
}

test('新しい observedAt は採用する', () => {
  expect(
    shouldReplaceLatest(existing, {
      observedAt: '2026-08-23T04:01:00.000Z',
      receivedAt: '2026-08-23T04:01:01.000Z'
    })
  ).toBe(true)
})

test('古い観測値が遅れて到着しても上書きしない', () => {
  expect(
    shouldReplaceLatest(existing, {
      observedAt: '2026-08-23T03:59:00.000Z',
      receivedAt: '2026-08-23T05:00:00.000Z'
    })
  ).toBe(false)
})

test('observedAt が同一時刻なら新しい receivedAt を採用する', () => {
  expect(
    shouldReplaceLatest(existing, {
      observedAt: '2026-08-23T04:00:00.000Z',
      receivedAt: '2026-08-23T04:00:06.000Z'
    })
  ).toBe(true)
})

test('observedAt も receivedAt も同一なら上書きしない', () => {
  expect(shouldReplaceLatest(existing, existing)).toBe(false)
})

test('タイムゾーン表記が異なっても時刻として比較する', () => {
  expect(
    shouldReplaceLatest(existing, {
      observedAt: '2026-08-23T13:00:01.000+09:00',
      receivedAt: '2026-08-23T13:00:02.000+09:00'
    })
  ).toBe(true)
})

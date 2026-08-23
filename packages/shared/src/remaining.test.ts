import { expect, test } from 'vite-plus/test'
import { calcRemainingPercent, displayTone, remainingLevel } from './remaining.js'

test('calcRemainingPercent は 100 - usedPercent を 0..100 に clamp する', () => {
  expect(calcRemainingPercent(0)).toBe(100)
  expect(calcRemainingPercent(28.5)).toBe(71.5)
  expect(calcRemainingPercent(100)).toBe(0)
  expect(calcRemainingPercent(120)).toBe(0)
  expect(calcRemainingPercent(-5)).toBe(100)
})

test('remainingLevel の境界値(仕様 9.2: 50%以上=緑 / 20%以上50%未満=黄 / 20%未満=赤)', () => {
  expect(remainingLevel(100)).toBe('high')
  expect(remainingLevel(50)).toBe('high')
  expect(remainingLevel(49.9)).toBe('medium')
  expect(remainingLevel(20)).toBe('medium')
  expect(remainingLevel(19.9)).toBe('low')
  expect(remainingLevel(0)).toBe('low')
})

test('fresh は残量に応じた色になる', () => {
  expect(displayTone({ freshness: 'fresh', remainingPercent: 50 })).toBe('green')
  expect(displayTone({ freshness: 'fresh', remainingPercent: 20 })).toBe('yellow')
  expect(displayTone({ freshness: 'fresh', remainingPercent: 19.9 })).toBe('red')
})

test('stale / expired はグレー', () => {
  expect(displayTone({ freshness: 'stale', remainingPercent: 100 })).toBe('gray')
  expect(displayTone({ freshness: 'expired', remainingPercent: 0 })).toBe('gray')
})

test('never / 取得不能はダークグレー', () => {
  expect(displayTone({ freshness: 'never', remainingPercent: null })).toBe('darkgray')
  expect(displayTone({ freshness: 'fresh', remainingPercent: null })).toBe('darkgray')
})

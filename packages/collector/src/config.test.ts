import { expect, test } from 'vite-plus/test'
import {
  resolveCollectorMode,
  resolveNonNegativeInt,
  resolvePositiveInt,
  resolveProviders
} from './config.js'

test('COLLECTOR_MODE の既定は real', () => {
  expect(resolveCollectorMode(undefined)).toBe('real')
  expect(resolveCollectorMode('')).toBe('real')
  expect(resolveCollectorMode('   ')).toBe('real')
})

test('mock は明示指定した場合だけ有効になる', () => {
  expect(resolveCollectorMode('mock')).toBe('mock')
  expect(resolveCollectorMode('real')).toBe('real')
})

test('未知の COLLECTOR_MODE は起動時に落とす(黙って real/mock に寄せない)', () => {
  expect(() => resolveCollectorMode('fixture')).toThrow(/COLLECTOR_MODE/)
  expect(() => resolveCollectorMode('MOCK')).toThrow(/COLLECTOR_MODE/)
  expect(() => resolveCollectorMode('true')).toThrow(/COLLECTOR_MODE/)
})

test('provider 一覧を解決し重複を畳む', () => {
  expect(resolveProviders(undefined)).toEqual(['codex', 'claude'])
  expect(resolveProviders('claude')).toEqual(['claude'])
  expect(resolveProviders(' codex , claude ')).toEqual(['codex', 'claude'])
  expect(resolveProviders('codex,codex')).toEqual(['codex'])
})

test('未知の provider と空指定は起動時に落とす', () => {
  expect(() => resolveProviders('gemini')).toThrow(/unknown provider/)
  expect(() => resolveProviders('')).toThrow(/at least one provider/)
  expect(() => resolveProviders(',,')).toThrow(/at least one provider/)
})

test('非負整数を検証して解決する', () => {
  expect(resolveNonNegativeInt({ raw: undefined, fallback: 7, name: 'X' })).toBe(7)
  expect(resolveNonNegativeInt({ raw: '', fallback: 7, name: 'X' })).toBe(7)
  expect(resolveNonNegativeInt({ raw: '0', fallback: 7, name: 'X' })).toBe(0)
  expect(resolveNonNegativeInt({ raw: ' 60 ', fallback: 7, name: 'X' })).toBe(60)
  expect(() => resolveNonNegativeInt({ raw: '-1', fallback: 7, name: 'X' })).toThrow(/X/)
  expect(() => resolveNonNegativeInt({ raw: '1.5', fallback: 7, name: 'X' })).toThrow(/X/)
  expect(() => resolveNonNegativeInt({ raw: 'abc', fallback: 7, name: 'X' })).toThrow(/X/)
})

test('正整数は 0 を拒否する', () => {
  expect(resolvePositiveInt({ raw: '30000', fallback: 1, name: 'X' })).toBe(30000)
  expect(() => resolvePositiveInt({ raw: '0', fallback: 1, name: 'X' })).toThrow(/positive/)
})

test('SEND_TIMEOUT_MS の既定は 30 秒で正整数を検証する', () => {
  expect(resolvePositiveInt({ raw: undefined, fallback: 30_000, name: 'SEND_TIMEOUT_MS' })).toBe(
    30_000
  )
  expect(resolvePositiveInt({ raw: ' 5000 ', fallback: 30_000, name: 'SEND_TIMEOUT_MS' })).toBe(
    5000
  )
  expect(() => resolvePositiveInt({ raw: '0', fallback: 30_000, name: 'SEND_TIMEOUT_MS' })).toThrow(
    /positive/
  )
})

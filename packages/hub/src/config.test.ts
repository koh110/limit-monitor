import { expect, test } from 'vite-plus/test'
import { resolveCorsAllowedOrigins, resolvePositiveInt } from './config.js'

test('collector trigger interval は正の整数だけを受け付ける', () => {
  expect(resolvePositiveInt({ raw: undefined, fallback: 60, name: 'INTERVAL' })).toBe(60)
  expect(resolvePositiveInt({ raw: '15', fallback: 60, name: 'INTERVAL' })).toBe(15)
  expect(resolvePositiveInt({ raw: '2147483', fallback: 60, name: 'INTERVAL', max: 2147483 })).toBe(
    2147483
  )
  expect(() =>
    resolvePositiveInt({ raw: '2147484', fallback: 60, name: 'INTERVAL', max: 2147483 })
  ).toThrow()
  expect(() => resolvePositiveInt({ raw: '0', fallback: 60, name: 'INTERVAL' })).toThrow()
  expect(() => resolvePositiveInt({ raw: '-1', fallback: 60, name: 'INTERVAL' })).toThrow()
})

test('CORS_ALLOWED_ORIGINS はカンマ区切りを trim して配列にする', () => {
  expect(
    resolveCorsAllowedOrigins({ raw: ' http://a.example , http://b.example ', isProduction: false })
  ).toEqual(['http://a.example', 'http://b.example'])
})

test('未設定は空配列(fail closed)になる', () => {
  expect(resolveCorsAllowedOrigins({ raw: undefined, isProduction: false })).toEqual([])
  expect(resolveCorsAllowedOrigins({ raw: '', isProduction: false })).toEqual([])
})

test('local/test では "*" を許容する', () => {
  expect(resolveCorsAllowedOrigins({ raw: '*', isProduction: false })).toBe('*')
})

test('production では "*" を拒否する', () => {
  expect(() => resolveCorsAllowedOrigins({ raw: '*', isProduction: true })).toThrow()
})

test('production では未設定(空)を拒否する', () => {
  expect(() => resolveCorsAllowedOrigins({ raw: '', isProduction: true })).toThrow()
  expect(() => resolveCorsAllowedOrigins({ raw: undefined, isProduction: true })).toThrow()
})

test('production でも明示的な origin 一覧は許可する', () => {
  expect(
    resolveCorsAllowedOrigins({ raw: 'https://dashboard.example.com', isProduction: true })
  ).toEqual(['https://dashboard.example.com'])
})

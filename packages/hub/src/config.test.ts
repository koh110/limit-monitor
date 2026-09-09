import { expect, test } from 'vite-plus/test'
import { resolveCorsAllowedOrigins } from './config.js'

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

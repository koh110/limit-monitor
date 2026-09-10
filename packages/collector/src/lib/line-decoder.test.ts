import { expect, test } from 'vite-plus/test'
import { createLineDecoder } from './line-decoder.js'

test('newline ごとに行を取り出す', () => {
  const decoder = createLineDecoder({ maxBufferBytes: 1024 })
  expect(decoder.push(Buffer.from('a\nb\n'))).toEqual({ ok: true, lines: ['a', 'b'] })
})

test('チャンク境界で分割された行を結合する', () => {
  const decoder = createLineDecoder({ maxBufferBytes: 1024 })
  expect(decoder.push(Buffer.from('{"id":'))).toEqual({ ok: true, lines: [] })
  expect(decoder.push(Buffer.from('1}\n'))).toEqual({ ok: true, lines: ['{"id":1}'] })
})

test('CRLF と空行を扱う', () => {
  const decoder = createLineDecoder({ maxBufferBytes: 1024 })
  expect(decoder.push(Buffer.from('a\r\n\nb\r\n'))).toEqual({ ok: true, lines: ['a', 'b'] })
})

test('multi-byte 文字がチャンク境界を跨いでも壊れない', () => {
  const decoder = createLineDecoder({ maxBufferBytes: 1024 })
  const utf8 = Buffer.from('あ\n')
  expect(decoder.push(utf8.subarray(0, 2))).toEqual({ ok: true, lines: [] })
  expect(decoder.push(utf8.subarray(2))).toEqual({ ok: true, lines: ['あ'] })
})

test('newline なしで上限を超えたらエラーにする', () => {
  const decoder = createLineDecoder({ maxBufferBytes: 8 })
  const result = decoder.push(Buffer.from('123456789'))
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected failure')
  }
  expect(result.reason).toBe('buffer_limit_exceeded')
})

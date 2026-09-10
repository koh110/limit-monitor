import { expect, test } from 'vite-plus/test'
import {
  GROK_AGENT_ARGS,
  GROK_BILLING_ID,
  GROK_INITIALIZE_ID,
  buildGrokBillingRequest,
  buildGrokInitializeRequest,
  parseGrokMessage
} from './grok-protocol.js'

test('Grok agent は stdio ACP で起動する', () => {
  expect(GROK_AGENT_ARGS).toEqual(['agent', 'stdio'])
})

test('ACP initialize request は protocolVersion 1 を送る', () => {
  expect(JSON.parse(buildGrokInitializeRequest())).toEqual({
    jsonrpc: '2.0',
    id: GROK_INITIALIZE_ID,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {}
    }
  })
})

test('billing extension は ACP wire 上の underscore prefix を使う', () => {
  expect(JSON.parse(buildGrokBillingRequest())).toEqual({
    jsonrpc: '2.0',
    id: GROK_BILLING_ID,
    method: '_x.ai/billing',
    params: {}
  })
})

test('ACP result は id と result を分類する', () => {
  expect(parseGrokMessage('{"jsonrpc":"2.0","id":2,"result":{"config":{}}}')).toEqual({
    kind: 'result',
    id: GROK_BILLING_ID,
    result: { config: {} }
  })
})

test('notification と壊れた JSON は other に落とす', () => {
  expect(parseGrokMessage('{"jsonrpc":"2.0","method":"session/update","params":{}}')).toEqual({
    kind: 'other'
  })
  expect(parseGrokMessage('not-json')).toEqual({ kind: 'other' })
})

test('ACP error は原因調査用の情報だけを保持する', () => {
  expect(
    parseGrokMessage(
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"not authenticated"}}'
    )
  ).toEqual({
    kind: 'error',
    id: GROK_BILLING_ID,
    code: -32000,
    message: 'not authenticated'
  })
})

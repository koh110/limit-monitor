import { expect, test } from 'vite-plus/test'
import {
  GROK_AGENT_ARGS,
  GROK_BILLING_ID,
  GROK_INITIALIZE_ID,
  buildGrokBillingRequest,
  buildGrokInitializeRequest
} from './grok.js'

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

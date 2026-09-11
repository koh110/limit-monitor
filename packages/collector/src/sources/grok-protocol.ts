import * as z from 'zod/mini'

export const GROK_INITIALIZE_ID = 1 as const
export const GROK_BILLING_ID = 2 as const
export const GROK_AGENT_ARGS = ['agent', 'stdio'] as const

export function buildGrokInitializeRequest(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: GROK_INITIALIZE_ID,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {}
    }
  })
}

/** ACP extension methods are prefixed with `_` on the raw JSON-RPC wire. */
export function buildGrokBillingRequest(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: GROK_BILLING_ID,
    method: '_x.ai/billing',
    params: {}
  })
}

const ERROR_MESSAGE_MAX_LENGTH = 200

export type GrokMessage =
  | { kind: 'result'; id: number; result: unknown }
  | { kind: 'error'; id: number; code: number | null; message: string }
  | { kind: 'other' }

const messageSchema = z.object({
  id: z.optional(z.nullable(z.union([z.number(), z.string()]))),
  result: z.optional(z.unknown()),
  error: z.optional(
    z.nullable(
      z.object({
        code: z.optional(z.nullable(z.number())),
        message: z.optional(z.nullable(z.string()))
      })
    )
  )
})

/** `grok agent stdio` の 1 行を分類し、notification 等は `other` に落とす。 */
export function parseGrokMessage(line: string): GrokMessage {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { kind: 'other' }
  }
  const parsed = messageSchema.safeParse(raw)
  if (!parsed.success || typeof parsed.data.id !== 'number') {
    return { kind: 'other' }
  }
  const id = parsed.data.id
  const error = parsed.data.error
  if (error) {
    return {
      kind: 'error',
      id,
      code: error.code ?? null,
      message: (error.message ?? 'unknown Grok ACP error').slice(0, ERROR_MESSAGE_MAX_LENGTH)
    }
  }
  if ('result' in parsed.data) {
    return { kind: 'result', id, result: parsed.data.result }
  }
  return { kind: 'other' }
}

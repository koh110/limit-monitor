import * as z from 'zod/mini'
import { providerSchema, SCHEMA_VERSION } from './contracts.js'

export const CONTROL_MAX_PAYLOAD_BYTES = 8 * 1024

export const controlMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('collect'), triggerId: z.uuid() }),
  z.object({
    type: z.literal('refresh'),
    requestId: z.uuid(),
    leaseId: z.uuid(),
    provider: providerSchema
  }),
  z.object({ type: z.literal('job_started'), requestId: z.uuid(), leaseId: z.uuid() }),
  z.object({
    type: z.literal('job_finished'),
    requestId: z.uuid(),
    leaseId: z.uuid(),
    ok: z.boolean()
  }),
  z.object({ type: z.literal('heartbeat'), schemaVersion: z.literal(SCHEMA_VERSION) })
])
export type ControlMessage = z.infer<typeof controlMessageSchema>

export const refreshRequestBodySchema = z.object({
  provider: providerSchema,
  accountAlias: z.string().check(z.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
})
export type RefreshRequestBody = z.infer<typeof refreshRequestBodySchema>

export const refreshStatusSchema = z.enum([
  'queued',
  'dispatched',
  'running',
  'completed',
  'failed'
])
export type RefreshStatus = z.infer<typeof refreshStatusSchema>

export const refreshRequestResponseSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  requestId: z.uuid(),
  status: refreshStatusSchema
})
export type RefreshRequestResponse = z.infer<typeof refreshRequestResponseSchema>

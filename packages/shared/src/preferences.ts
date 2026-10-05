import * as z from 'zod/mini'
import {
  accountAliasSchema,
  bucketIdSchema,
  MAX_BUCKETS_PER_OBSERVATION,
  providerSchema,
  SCHEMA_VERSION
} from './contracts.js'

export const bucketOrderRequestSchema = z.object({
  provider: providerSchema,
  accountAlias: accountAliasSchema,
  bucketOrder: z
    .array(bucketIdSchema)
    .check(z.minLength(1), z.maxLength(MAX_BUCKETS_PER_OBSERVATION))
})
export type BucketOrderRequest = z.infer<typeof bucketOrderRequestSchema>

export const bucketOrderResponseSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  provider: providerSchema,
  accountAlias: accountAliasSchema,
  bucketOrder: z.array(bucketIdSchema)
})
export type BucketOrderResponse = z.infer<typeof bucketOrderResponseSchema>

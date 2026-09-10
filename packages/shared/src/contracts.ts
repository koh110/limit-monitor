import * as z from 'zod/mini'

export const SCHEMA_VERSION = 1 as const

export const MAX_BUCKETS_PER_OBSERVATION = 16 as const

export const providerSchema = z.enum(['codex', 'claude', 'grok'])
export type Provider = z.infer<typeof providerSchema>

// 生のアカウントID・メールアドレスの混入を防ぐため `@` 等を許可しない
const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const accountAliasSchema = z
  .string()
  .check(z.regex(aliasPattern, 'accountAlias must match [A-Za-z0-9._-]'))

export const sourceIdSchema = z
  .string()
  .check(z.regex(aliasPattern, 'sourceId must match [A-Za-z0-9._-]'))

export const bucketIdSchema = z
  .string()
  .check(z.regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/, 'bucketId must match [A-Za-z0-9:._-]'))

const isoDateTimeSchema = z.iso.datetime({ offset: true })

const percentSchema = z.number().check(z.gte(0), z.lte(100))

export const observationBucketSchema = z.object({
  bucketId: bucketIdSchema,
  label: z.string().check(z.minLength(1), z.maxLength(32)),
  usedPercent: percentSchema,
  remainingPercent: percentSchema,
  windowDurationSeconds: z.optional(z.nullable(z.int().check(z.gte(1), z.lte(366 * 24 * 60 * 60)))),
  resetsAt: z.optional(z.nullable(isoDateTimeSchema)),
  reached: z.optional(z.boolean())
})
export type ObservationBucket = z.infer<typeof observationBucketSchema>

// buckets は envelope 検証では中身を確定させない(不正な bucket が 1 件あっても
// 他の正常 bucket を破棄しない = bucket 単位の partial acceptance を行うため)。
// 各要素は ingest 側で observationBucketSchema により個別に検証する。
// accountAlias は認証 token 側が正とするため optional(明示した場合は
// token の accountAlias と一致しなければ Hub が 403 で拒否する)
export const observationSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  provider: providerSchema,
  accountAlias: z.optional(accountAliasSchema),
  sourceId: sourceIdSchema,
  observedAt: isoDateTimeSchema,
  buckets: z.array(z.unknown()).check(z.minLength(1), z.maxLength(MAX_BUCKETS_PER_OBSERVATION)),
  credits: z.optional(z.nullable(z.number()))
})
export type Observation = z.infer<typeof observationSchema>

export const freshnessSchema = z.enum(['fresh', 'stale', 'expired'])

export const statusBucketSchema = z.object({
  bucketId: bucketIdSchema,
  label: z.string(),
  usedPercent: percentSchema,
  remainingPercent: percentSchema,
  windowDurationSeconds: z.nullable(z.number()),
  resetsAt: z.nullable(isoDateTimeSchema),
  observedAt: isoDateTimeSchema,
  reached: z.boolean(),
  freshness: freshnessSchema
})
export type StatusBucket = z.infer<typeof statusBucketSchema>

export const statusAccountSchema = z.object({
  provider: providerSchema,
  accountAlias: accountAliasSchema,
  buckets: z.array(statusBucketSchema)
})
export type StatusAccount = z.infer<typeof statusAccountSchema>

export const statusResponseSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generatedAt: isoDateTimeSchema,
  accounts: z.array(statusAccountSchema)
})
export type StatusResponse = z.infer<typeof statusResponseSchema>

export const ingestResultSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  accepted: z.array(bucketIdSchema),
  skipped: z.array(
    z.object({
      bucketId: bucketIdSchema,
      reason: z.enum(['stale_observation'])
    })
  ),
  rejected: z.array(
    z.object({
      index: z.int().check(z.gte(0)),
      reason: z.string()
    })
  )
})
export type IngestResult = z.infer<typeof ingestResultSchema>

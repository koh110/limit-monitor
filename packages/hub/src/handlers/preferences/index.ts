import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq } from 'drizzle-orm'
import { bucketOrderRequestSchema } from 'shared/src/preferences'
import type * as schema from 'shared/src/schema'
import { accountBucketOrders, latestLimits } from 'shared/src/db/schema'
import type { Db } from '../../lib/database.js'
import { PREFERENCES_BODY_LIMIT_BYTES } from '../../config.js'
import { dashboardAuthMiddleware } from '../../lib/dashboard-auth.js'
import { createHttpException } from '../../lib/wrap.js'

type PreferencesApi = schema.paths['/api/v1/preferences/bucket-order']['put']
type PreferenceResponses = PreferencesApi['responses']

type ProblemResponse =
  | PreferenceResponses['400']['content']['application/problem+json']
  | PreferenceResponses['413']['content']['application/problem+json']

function badRequest(detail: string) {
  return createHttpException<ProblemResponse>(400, {
    type: 'about:blank',
    title: 'Bad Request',
    status: 400,
    detail
  })
}

export function createRoute(app: Hono, db: Db, dashboardApiToken: string | null) {
  app.put(
    '/api/v1/preferences/bucket-order',
    dashboardAuthMiddleware(dashboardApiToken),
    bodyLimit({
      maxSize: PREFERENCES_BODY_LIMIT_BYTES,
      onError: () => {
        throw createHttpException<ProblemResponse>(413, {
          type: 'about:blank',
          title: 'Content Too Large',
          status: 413,
          detail: `request body must be <= ${PREFERENCES_BODY_LIMIT_BYTES} bytes`
        })
      }
    }),
    async (c) => {
      let payload: unknown
      try {
        payload = await c.req.json()
      } catch {
        throw badRequest('request body must be valid JSON')
      }
      const parsed = bucketOrderRequestSchema.safeParse(payload)
      if (!parsed.success) {
        throw badRequest('invalid bucket order request')
      }

      const currentRows = await db
        .select({ bucketId: latestLimits.bucketId })
        .from(latestLimits)
        .where(
          and(
            eq(latestLimits.provider, parsed.data.provider),
            eq(latestLimits.accountAlias, parsed.data.accountAlias)
          )
        )
      if (currentRows.length === 0) {
        return c.json(
          {
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            detail: 'account is not connected'
          } satisfies PreferenceResponses['404']['content']['application/json'],
          404
        )
      }

      const currentBucketIds = currentRows.map((row) => row.bucketId)
      const requestedBucketIds = new Set(parsed.data.bucketOrder)
      const containsEveryCurrentBucket = currentBucketIds.every((bucketId) => {
        return requestedBucketIds.has(bucketId)
      })
      const containsOnlyCurrentBuckets = parsed.data.bucketOrder.every((bucketId) => {
        return currentBucketIds.includes(bucketId)
      })
      if (
        requestedBucketIds.size !== currentBucketIds.length ||
        !containsEveryCurrentBucket ||
        !containsOnlyCurrentBuckets
      ) {
        throw badRequest('bucketOrder must contain each current bucket exactly once')
      }

      const updatedAt = new Date().toISOString()
      await db
        .insert(accountBucketOrders)
        .values({
          provider: parsed.data.provider,
          accountAlias: parsed.data.accountAlias,
          bucketOrder: JSON.stringify(parsed.data.bucketOrder),
          updatedAt
        })
        .onConflictDoUpdate({
          target: [accountBucketOrders.provider, accountBucketOrders.accountAlias],
          set: {
            bucketOrder: JSON.stringify(parsed.data.bucketOrder),
            updatedAt
          }
        })

      return c.json({
        schemaVersion: 1,
        provider: parsed.data.provider,
        accountAlias: parsed.data.accountAlias,
        bucketOrder: parsed.data.bucketOrder
      } satisfies PreferenceResponses['200']['content']['application/json'])
    }
  )
}

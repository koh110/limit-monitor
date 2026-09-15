import type { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { bodyLimit } from 'hono/body-limit'
import { timingSafeEqual } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { refreshRequestBodySchema, refreshStatusSchema } from 'shared/src/control'
import type * as schema from 'shared/src/schema'
import { collectorTokens, latestLimits } from 'shared/src/db/schema'
import type { Db } from '../../lib/database.js'
import {
  claimQueuedRefresh,
  enqueueRefresh,
  getRefresh,
  releaseRefreshDispatch
} from '../../features/refresh/store.js'
import type { createControlRegistry } from '../../features/control.js'
import { REFRESH_BODY_LIMIT_BYTES } from '../../config.js'
import { createHttpException } from '../../lib/wrap.js'

type RefreshApi = schema.paths['/api/v1/refresh-requests']['post']
type RefreshResponse = RefreshApi['responses']
type RefreshUnauthorized = RefreshResponse['401']['content']['application/problem+json']

function sameSecret(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  )
}

function refreshAuthMiddleware(expectedToken: string | null) {
  return createMiddleware(async (c, next) => {
    const authorization = c.req.header('Authorization') ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    if (!expectedToken || !sameSecret(token, expectedToken)) {
      throw createHttpException<RefreshUnauthorized>(401, {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'invalid or missing dashboard refresh token'
      })
    }
    await next()
  })
}

export function createRoute(
  app: Hono,
  db: Db,
  controlRegistry: ReturnType<typeof createControlRegistry>,
  refreshApiToken: string | null
) {
  app.post(
    '/api/v1/refresh-requests',
    refreshAuthMiddleware(refreshApiToken),
    bodyLimit({
      maxSize: REFRESH_BODY_LIMIT_BYTES,
      onError: () => {
        throw createHttpException<RefreshResponse['413']['content']['application/problem+json']>(
          413,
          {
            type: 'about:blank',
            title: 'Content Too Large',
            status: 413,
            detail: `request body must be <= ${REFRESH_BODY_LIMIT_BYTES} bytes`
          }
        )
      }
    }),
    async (c) => {
      let payload: unknown
      try {
        payload = await c.req.json()
      } catch {
        throw createHttpException<RefreshResponse['400']['content']['application/problem+json']>(
          400,
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: 'request body must be valid JSON'
          }
        )
      }
      const parsed = refreshRequestBodySchema.safeParse(payload)
      if (!parsed.success) {
        throw createHttpException<RefreshResponse['400']['content']['application/problem+json']>(
          400,
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: 'invalid refresh request'
          }
        )
      }
      const rows = await db
        .select({ sourceId: latestLimits.sourceId })
        .from(latestLimits)
        .where(
          and(
            eq(latestLimits.provider, parsed.data.provider),
            eq(latestLimits.accountAlias, parsed.data.accountAlias)
          )
        )
        .orderBy(
          desc(latestLimits.observedAt),
          desc(latestLimits.receivedAt),
          desc(latestLimits.sourceId)
        )
        .limit(1)
      const tokenRows = rows[0]
        ? []
        : await db
            .select({ sourceId: collectorTokens.sourceId })
            .from(collectorTokens)
            .where(
              and(
                eq(collectorTokens.accountAlias, parsed.data.accountAlias),
                isNull(collectorTokens.revokedAt)
              )
            )
            .orderBy(desc(collectorTokens.createdAt), desc(collectorTokens.sourceId))
            .limit(1)
      const sourceId = rows[0]?.sourceId ?? tokenRows[0]?.sourceId
      if (!sourceId) {
        return c.json(
          {
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            detail: 'account is not connected'
          },
          404
        )
      }
      const result = await enqueueRefresh({ db, ...parsed.data, sourceId, now: new Date() })
      const session = controlRegistry.find(sourceId, parsed.data.accountAlias)
      if (result.status === 'queued' && session) {
        const claim = await claimQueuedRefresh({ db, id: result.id, now: new Date() })
        if (claim) {
          let sent = false
          try {
            sent = session.send({
              type: 'refresh',
              requestId: claim.id,
              leaseId: claim.leaseId,
              provider: parsed.data.provider
            })
          } catch {
            sent = false
          }
          if (sent) {
            return c.json(
              {
                schemaVersion: 1,
                requestId: claim.id,
                status: 'dispatched'
              } satisfies RefreshResponse['202']['content']['application/json'],
              202
            )
          }
          await releaseRefreshDispatch({
            db,
            id: claim.id,
            dispatchedAt: claim.dispatchedAt,
            leaseId: claim.leaseId
          })
        }
      }
      const current = await getRefresh({ db, id: result.id })
      const status = refreshStatusSchema.parse(current?.status ?? result.status)
      return c.json(
        {
          schemaVersion: 1,
          requestId: result.id,
          status
        } satisfies RefreshResponse['202']['content']['application/json'],
        202
      )
    }
  )

  app.get('/api/v1/refresh-requests/:requestId', async (c) => {
    const result = await getRefresh({ db, id: c.req.param('requestId') })
    if (!result) {
      return c.json({ type: 'about:blank', title: 'Not Found', status: 404 }, 404)
    }
    const status = refreshStatusSchema.parse(result.status)
    return c.json({
      schemaVersion: 1,
      requestId: result.id,
      status
    } satisfies schema.components['schemas']['RefreshRequestResponse'])
  })
}

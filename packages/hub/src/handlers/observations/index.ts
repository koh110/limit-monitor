import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { validator } from 'hono/validator'
import { observationSchema } from 'shared/src/contracts'
import type * as schema from 'shared/src/schema'
import { INGEST_BODY_LIMIT_BYTES } from '../../config.js'
import { ingestObservation } from '../../features/observations/ingest.js'
import type { Db } from '../../lib/database.js'
import { collectorAuthMiddleware, ingestRateLimitMiddleware } from '../../lib/middleware.js'
import type { RateLimiter } from '../../lib/rate-limit.js'
import { createHttpException } from '../../lib/wrap.js'

type IngestApi = schema.paths['/api/v1/observations']['post']
type IngestResponse = IngestApi['responses']

export function createRoute(app: Hono, db: Db, rateLimiter: RateLimiter) {
  app.post(
    '/api/v1/observations' satisfies keyof schema.paths,
    bodyLimit({
      maxSize: INGEST_BODY_LIMIT_BYTES,
      onError: () => {
        throw createHttpException<IngestResponse['413']['content']['application/problem+json']>(
          413,
          {
            type: 'about:blank',
            title: 'Content Too Large',
            status: 413,
            detail: `request body must be <= ${INGEST_BODY_LIMIT_BYTES} bytes`
          }
        )
      }
    }),
    collectorAuthMiddleware(db),
    ingestRateLimitMiddleware(rateLimiter),
    validator('json', (value): IngestApi['requestBody']['content']['application/json'] => {
      const parsed = observationSchema.safeParse(value)
      if (!parsed.success) {
        throw createHttpException<IngestResponse['400']['content']['application/problem+json']>(
          400,
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: parsed.error.issues
              .map((issue) => {
                return `${issue.path.join('.')}: ${issue.message}`
              })
              .join(', ')
          }
        )
      }
      return parsed.data
    }),
    async (c) => {
      const observation = c.req.valid('json')
      const result = await ingestObservation({
        db,
        observation,
        tokenSourceId: c.get('tokenSourceId'),
        tokenAccountAlias: c.get('tokenAccountAlias'),
        now: new Date()
      })
      return c.json(result satisfies IngestResponse['200']['content']['application/json'])
    }
  )
}

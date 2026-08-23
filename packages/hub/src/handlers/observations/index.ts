import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { validator } from 'hono/validator'
import type { IngestResult, Observation } from 'shared/src/contracts'
import { observationSchema } from 'shared/src/contracts'
import { INGEST_BODY_LIMIT_BYTES } from '../../config.js'
import { ingestObservation } from '../../features/observations/ingest.js'
import type { Db } from '../../lib/database.js'
import { collectorAuthMiddleware, ingestRateLimitMiddleware } from '../../lib/middleware.js'
import type { RateLimiter } from '../../lib/rate-limit.js'
import type { ProblemDetails } from '../../lib/wrap.js'
import { createHttpException } from '../../lib/wrap.js'

export function createRoute(app: Hono, db: Db, rateLimiter: RateLimiter) {
  app.post(
    '/api/v1/observations',
    bodyLimit({
      maxSize: INGEST_BODY_LIMIT_BYTES,
      onError: () => {
        throw createHttpException<ProblemDetails>(413, {
          type: 'about:blank',
          title: 'Content Too Large',
          status: 413,
          detail: `request body must be <= ${INGEST_BODY_LIMIT_BYTES} bytes`
        })
      }
    }),
    collectorAuthMiddleware(db),
    ingestRateLimitMiddleware(rateLimiter),
    validator('json', (value): Observation => {
      const parsed = observationSchema.safeParse(value)
      if (!parsed.success) {
        throw createHttpException<ProblemDetails>(400, {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: parsed.error.issues
            .map((issue) => {
              return `${issue.path.join('.')}: ${issue.message}`
            })
            .join(', ')
        })
      }
      return parsed.data
    }),
    async (c) => {
      const observation = c.req.valid('json')
      const result = await ingestObservation({
        db,
        observation,
        tokenSourceId: c.get('tokenSourceId'),
        now: new Date()
      })
      return c.json(result satisfies IngestResult)
    }
  )
}

import { Hono } from 'hono'
import { INGEST_RATE_LIMIT } from './config.js'
import type { Db } from './lib/database.js'
import { accessLogMiddleware } from './lib/middleware.js'
import type { RateLimiter } from './lib/rate-limit.js'
import { createRateLimiter } from './lib/rate-limit.js'
import type { ProblemDetails } from './lib/wrap.js'
import { handleError } from './lib/wrap.js'
import * as health from './handlers/health/index.js'
import * as observations from './handlers/observations/index.js'
import * as status from './handlers/status/index.js'

export function createApp({
  db,
  rateLimiter = createRateLimiter(INGEST_RATE_LIMIT)
}: {
  db: Db
  rateLimiter?: RateLimiter
}) {
  const app = new Hono()
  app.use(accessLogMiddleware())
  app.onError(handleError)
  app.notFound((c) => {
    return c.json(
      {
        type: 'about:blank',
        title: 'Not Found',
        status: 404
      } satisfies ProblemDetails,
      404
    )
  })

  health.createRoute(app, db)
  status.createRoute(app, db)
  observations.createRoute(app, db, rateLimiter)

  return app
}

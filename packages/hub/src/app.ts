import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type * as schema from 'shared/src/schema'
import { CORS_ALLOWED_ORIGINS, HUB_REFRESH_TOKEN, INGEST_RATE_LIMIT } from './config.js'
import type { Db } from './lib/database.js'
import { accessLogMiddleware } from './lib/middleware.js'
import type { RateLimiter } from './lib/rate-limit.js'
import { createRateLimiter } from './lib/rate-limit.js'
import { handleError } from './lib/wrap.js'
import { createControlRegistry } from './features/control.js'
import * as health from './handlers/health/index.js'
import * as observations from './handlers/observations/index.js'
import * as status from './handlers/status/index.js'
import * as refresh from './handlers/refresh/index.js'

export function createApp({
  db,
  rateLimiter = createRateLimiter(INGEST_RATE_LIMIT),
  corsAllowedOrigins = CORS_ALLOWED_ORIGINS,
  controlRegistry = createControlRegistry(),
  refreshApiToken = HUB_REFRESH_TOKEN
}: {
  db: Db
  rateLimiter?: RateLimiter
  corsAllowedOrigins?: string | string[]
  controlRegistry?: ReturnType<typeof createControlRegistry>
  refreshApiToken?: string | null
}) {
  const app = new Hono()
  app.use(accessLogMiddleware())
  // ブラウザが Hub を直接叩く(reverse proxy なし)ための CORS。
  // exact origin match のみ許可し、denied origin には Access-Control-Allow-Origin を付けない。
  app.use('*', cors({ origin: corsAllowedOrigins }))
  app.onError(handleError)
  // 404 は個別 operation ではなく app 全体の fallback のため、契約は
  // components の NotFoundError を直接参照する(media type は application/json)
  app.notFound((c) => {
    return c.json(
      {
        type: 'about:blank',
        title: 'Not Found',
        status: 404
      } satisfies schema.components['schemas']['NotFoundError'],
      404
    )
  })

  health.createRoute(app, db)
  status.createRoute(app, db)
  observations.createRoute(app, db, rateLimiter)
  refresh.createRoute(app, db, controlRegistry, refreshApiToken)

  return app
}

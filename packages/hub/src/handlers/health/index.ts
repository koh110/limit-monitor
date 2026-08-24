import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { SCHEMA_VERSION } from 'shared/src/contracts'
import type * as schema from 'shared/src/schema'
import { APP_VERSION } from '../../config.js'
import type { Db } from '../../lib/database.js'
import { logger } from '../../lib/logger.js'

type HealthzResponse = schema.paths['/healthz']['get']['responses']
type ReadyzResponse = schema.paths['/readyz']['get']['responses']

export function createRoute(app: Hono, db: Db) {
  app.get('/healthz' satisfies keyof schema.paths, (c) => {
    return c.json({
      status: 'ok',
      version: APP_VERSION,
      schemaVersion: SCHEMA_VERSION
    } satisfies HealthzResponse['200']['content']['application/json'])
  })

  app.get('/readyz' satisfies keyof schema.paths, async (c) => {
    try {
      await db.run(sql`SELECT 1 FROM latest_limits LIMIT 1`)
      return c.json({
        status: 'ok',
        version: APP_VERSION,
        schemaVersion: SCHEMA_VERSION
      } satisfies ReadyzResponse['200']['content']['application/json'])
    } catch (error) {
      logger.error({ label: 'readyz', body: 'db check failed', error })
      return c.json(
        {
          status: 'unavailable'
        } satisfies ReadyzResponse['503']['content']['application/json'],
        503
      )
    }
  })
}

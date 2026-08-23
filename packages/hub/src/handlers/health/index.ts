import type { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { SCHEMA_VERSION } from 'shared/src/contracts'
import { APP_VERSION } from '../../config.js'
import type { Db } from '../../lib/database.js'
import { logger } from '../../lib/logger.js'

export function createRoute(app: Hono, db: Db) {
  app.get('/healthz', (c) => {
    return c.json({
      status: 'ok',
      version: APP_VERSION,
      schemaVersion: SCHEMA_VERSION
    })
  })

  app.get('/readyz', async (c) => {
    try {
      await db.run(sql`SELECT 1 FROM latest_limits LIMIT 1`)
      return c.json({
        status: 'ok',
        version: APP_VERSION,
        schemaVersion: SCHEMA_VERSION
      })
    } catch (error) {
      logger.error({ label: 'readyz', body: 'db check failed', error })
      return c.json({ status: 'unavailable' }, 503)
    }
  })
}

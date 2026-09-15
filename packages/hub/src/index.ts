import path from 'node:path'
import { createServer } from 'node:http'
import { serve } from '@hono/node-server'
import { SCHEMA_VERSION } from 'shared/src/contracts'
import { createApp } from './app.js'
import { APP_VERSION, COLLECTOR_TRIGGER_INTERVAL_MS, DB_FILE_PATH, ENV, PORT } from './config.js'
import { attachControlServer } from './features/control-server.js'
import { createControlRegistry } from './features/control.js'
import { createDb, migrateDb } from './lib/database.js'
import { logger } from './lib/logger.js'

let server: ReturnType<typeof serve> | null = null
let control: ReturnType<typeof attachControlServer> | null = null

function main() {
  const db = createDb(DB_FILE_PATH)
  // 起動時に migration を適用する(systemd 再起動での自動復旧のため冪等)
  migrateDb(db, path.resolve(import.meta.dirname, '../../drizzle'))

  const registry = createControlRegistry()
  const app = createApp({ db, controlRegistry: registry })

  server = serve(
    {
      fetch: app.fetch,
      port: PORT,
      hostname: '0.0.0.0',
      createServer
    },
    (info) => {
      logger.log({
        label: 'server started',
        body: `Limit Hub is running on port ${info.port}`,
        meta: { version: APP_VERSION, schemaVersion: SCHEMA_VERSION }
      })
    }
  )
  control = attachControlServer({
    server,
    db,
    intervalMs: COLLECTOR_TRIGGER_INTERVAL_MS,
    registry
  })
}

try {
  main()
} catch (error) {
  logger.error({ label: 'server error', body: 'failed to start', error })
  process.exitCode = 1
}

// graceful shutdown
if (ENV.production) {
  process.on('SIGTERM', (signal) => {
    logger.log({ label: 'graceful shutdown', body: signal })
    control?.close()
    if (!server) {
      process.exit(0)
    }
    server.close((err) => {
      if (err) {
        logger.error({ label: 'graceful shutdown', body: 'error', error: err })
        return process.exit(1)
      }
      logger.log({ label: 'graceful shutdown', body: 'exit' })
      process.exit(0)
    })

    setTimeout(() => {
      logger.error({ label: 'graceful shutdown', body: 'timeout' })
      process.exit(1)
    }, 20000)
  })
}

import path from 'node:path'
import { serve } from '@hono/node-server'
import { SCHEMA_VERSION } from 'shared/src/contracts'
import { createApp } from './app.js'
import { APP_VERSION, DB_FILE_PATH, ENV, PORT } from './config.js'
import { createDb, migrateDb } from './lib/database.js'
import { logger } from './lib/logger.js'

let server: ReturnType<typeof serve> | null = null

function main() {
  const db = createDb(DB_FILE_PATH)
  // 起動時に migration を適用する(systemd 再起動での自動復旧のため冪等)
  migrateDb(db, path.resolve(import.meta.dirname, '../../drizzle'))

  const app = createApp({ db })

  server = serve(
    {
      fetch: app.fetch,
      port: PORT,
      hostname: '0.0.0.0'
    },
    (info) => {
      logger.log({
        label: 'server started',
        body: `Limit Hub is running on port ${info.port}`,
        meta: { version: APP_VERSION, schemaVersion: SCHEMA_VERSION }
      })
    }
  )
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

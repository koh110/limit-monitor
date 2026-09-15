import { DASHBOARD_DIST_DIR, HOST, HUB_REFRESH_TOKEN, HUB_URL, PORT } from './config.js'
import { logger } from './logger.js'
import { createStaticServer } from './static-server.js'

const server = createStaticServer({
  distDir: DASHBOARD_DIST_DIR,
  hubUrl: HUB_URL,
  hubRefreshToken: HUB_REFRESH_TOKEN
})

server.listen(PORT, HOST, () => {
  logger.log({
    label: 'dashboard started',
    body: `Limit Monitor Dashboard is running on ${HOST}:${PORT}`,
    meta: { distDir: DASHBOARD_DIST_DIR }
  })
})

server.on('error', (error: Error) => {
  logger.error({ label: 'dashboard error', body: 'failed to listen', error })
  process.exitCode = 1
})

// graceful shutdown(systemd の stop / restart で in-flight を切らない)
process.on('SIGTERM', () => {
  logger.log({ label: 'dashboard shutdown', body: 'SIGTERM' })
  server.close(() => {
    process.exit(0)
  })
  setTimeout(() => {
    logger.error({ label: 'dashboard shutdown', body: 'timeout' })
    process.exit(1)
  }, 10_000).unref()
})

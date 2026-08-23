export const ENV = {
  production: process.env.APP_ENV === 'production',
  test: process.env.APP_ENV === 'test',
  local: process.env.APP_ENV === 'local'
} as const

export const PORT = process.env.PORT ? Number(process.env.PORT) : 8787

export const DB_FILE_PATH = process.env.DB_FILE_PATH ?? './data/limit-monitor.sqlite'

export const APP_VERSION = '0.1.0' as const

// Ingest のリクエストボディ上限(仕様 7.2「リクエストボディ上限を小さく設定する」)
export const INGEST_BODY_LIMIT_BYTES = 32 * 1024

// Ingest の in-memory rate limit(fixed window)
export const INGEST_RATE_LIMIT = {
  windowMs: 60 * 1000,
  max: 120
} as const

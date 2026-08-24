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

// ブラウザが Hub を直接叩く(reverse proxy なし)ための許可 origin を解決する。
// production では未設定・ワイルドカードともに fail closed(起動を止める)。
export function resolveCorsAllowedOrigins({
  raw,
  isProduction
}: {
  raw: string | undefined
  isProduction: boolean
}): string | string[] {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '*') {
    if (isProduction) {
      throw new Error('CORS_ALLOWED_ORIGINS must not be "*" when APP_ENV=production')
    }
    return '*'
  }
  const origins = trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
  if (isProduction && origins.length === 0) {
    throw new Error('CORS_ALLOWED_ORIGINS must list explicit origins when APP_ENV=production')
  }
  return origins
}

export const CORS_ALLOWED_ORIGINS = resolveCorsAllowedOrigins({
  raw: process.env.CORS_ALLOWED_ORIGINS,
  isProduction: ENV.production
})

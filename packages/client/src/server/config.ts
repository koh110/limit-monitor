import path from 'node:path'

/**
 * Dashboard 配信 server の設定。環境変数の参照はこのファイルに閉じる。
 *
 * 不正値は起動時に落とす(黙って既定値へ寄せない)。同一ホストで Hub や
 * 他サービスと同居させるため、port と bind address は必ず設定で変えられる。
 */
function resolvePort(raw: string | undefined) {
  const trimmed = (raw ?? '').trim()
  if (trimmed.length === 0) {
    return 8788
  }
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (got: "${trimmed}")`)
  }
  return value
}

function resolveHubUrl(raw: string | undefined) {
  const trimmed = (raw ?? '').trim() || 'http://127.0.0.1:8787'
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`HUB_URL must be an absolute http(s) URL (got: "${trimmed}")`)
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== '/' ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(`HUB_URL must be an origin without credentials or path (got: "${trimmed}")`)
  }
  return parsed.origin
}

export const HUB_URL = resolveHubUrl(process.env.HUB_URL)
export const HUB_REFRESH_TOKEN = process.env.HUB_REFRESH_TOKEN?.trim() || null

export const PORT = resolvePort(process.env.PORT)

// 既定は localhost のみ。LAN へ公開する場合だけ明示的に 0.0.0.0 や
// 特定の LAN address を設定する(既定で外へ出さない)。
export const HOST = (process.env.HOST ?? '').trim() || '127.0.0.1'

// ブラウザがアクセスする public origin。bind address(HOST)と分離して保持する。
// 配信 server 自体は配信に origin を使わないが、deploy.sh の CORS 検証と
// 運用ドキュメントで参照する値の単一ソースとして定義する。
// 未設定の場合は localhost 既定 bind のみ HOST/PORT 由来で導出する。
// DASHBOARD_PUBLIC_ORIGIN を URL として厳密に検証する。
// 許される形は http(s)://host[:port] のみ:
//   - scheme: http / https
//   - host: 非空。userinfo(user:pass@)は禁止
//   - port: 任意、1-65535
//   - pathname: 空のみ(末尾 / は Hub の Origin exact match と不一致になるため禁止)
//   - search(?) / hash(#) は禁止
// deploy.sh の is_strict_origin と一致させる(双方で同じ URL 集合を受理する)。
function isStrictOrigin(value: string): boolean {
  const match = /^https?:\/\/([^/?#@:]+)(?::(\d{1,5}))?$/.exec(value)
  if (!match) {
    return false
  }
  if (match[2] !== undefined) {
    const port = Number(match[2])
    if (port < 1 || port > 65535) {
      return false
    }
  }
  return true
}

function resolvePublicOrigin(raw: string | undefined, host: string, port: number) {
  const trimmed = (raw ?? '').trim()
  if (trimmed.length > 0) {
    if (!isStrictOrigin(trimmed)) {
      throw new Error(
        `DASHBOARD_PUBLIC_ORIGIN must be an origin (http://host or https://host, optional :port; no path/search/hash/credentials, got: "${trimmed}")`
      )
    }
    return trimmed
  }
  if (host === '127.0.0.1' || host === 'localhost') {
    return `http://${host}:${port}`
  }
  throw new Error(
    `DASHBOARD_PUBLIC_ORIGIN must be set when HOST=${host} (LAN bind); it is the browser-facing origin used for CORS`
  )
}

export const DASHBOARD_PUBLIC_ORIGIN = resolvePublicOrigin(
  process.env.DASHBOARD_PUBLIC_ORIGIN,
  HOST,
  PORT
)

// 配信する静的ファイルの root。既定は dist/server から見た dist/public。
// release 配置先が変わっても ${INSTALL_DIR} 配下の相対関係は変わらないため、
// 通常は設定不要。
export const DASHBOARD_DIST_DIR = process.env.DASHBOARD_DIST_DIR
  ? path.resolve(process.env.DASHBOARD_DIST_DIR.trim())
  : path.resolve(import.meta.dirname, '../public')

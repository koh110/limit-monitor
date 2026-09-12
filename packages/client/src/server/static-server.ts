import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

/**
 * 拡張子 -> Content-Type。表に無い拡張子は sniff させず octet-stream にする。
 * オブジェクトリテラルの添字アクセス(と型 assertion)を避けるため Map で持つ。
 */
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json']
])

const DEFAULT_CONTENT_TYPE = 'application/octet-stream' as const

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable' as const
const REFRESH_PROXY_PATH = '/api/v1/refresh-requests' as const
const REFRESH_PROXY_BODY_LIMIT_BYTES = 8 * 1024
const REFRESH_PROXY_TIMEOUT_MS = 10_000

export function contentTypeOf(filePath: string) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? DEFAULT_CONTENT_TYPE
}

export type ResolvedStaticPath =
  | { ok: true; pathname: string; filePath: string }
  | { ok: false; reason: 'invalid_url' | 'traversal' }

/**
 * request URL を dist 配下の実 path へ解決する。root の外へ出る path は
 * 一切返さない(fail closed)。
 *
 * - `/` で始まらない、または `//`(protocol relative)で始まる URL は拒否する
 * - query / fragment を落としてから percent encoding を decode する
 *   (`new URL()` の正規化に任せず、`..` を自分で判定するため)
 * - decode 後に `..` segment を含む path は raw / encoded の別なく拒否する。
 *   SPA の route も Vite の asset も `..` を含まないため許可する理由がない
 * - NUL と backslash は separator として解釈されうるため拒否する
 * - 最後に resolve 後の絶対 path が root 配下であることも検証する(多重防御)
 */
export function resolveStaticPath({
  distDir,
  requestUrl
}: {
  distDir: string
  requestUrl: string
}): ResolvedStaticPath {
  if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) {
    return { ok: false, reason: 'invalid_url' }
  }
  const rawPath = (requestUrl.split('?')[0] ?? '').split('#')[0] ?? ''
  let pathname: string
  try {
    pathname = decodeURIComponent(rawPath)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    return { ok: false, reason: 'invalid_url' }
  }
  const hasDotDot = pathname.split('/').some((segment) => {
    return segment === '..'
  })
  if (hasDotDot) {
    return { ok: false, reason: 'traversal' }
  }
  const root = path.resolve(distDir)
  const filePath = path.resolve(root, `.${pathname}`)
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    return { ok: false, reason: 'traversal' }
  }
  return { ok: true, pathname, filePath }
}

/**
 * SPA fallback の対象か。拡張子付きの URL は asset 要求とみなして
 * fallback せず 404 にする(存在しない asset に index.html を返さない)。
 */
export function shouldFallbackToIndex(pathname: string) {
  return pathname.endsWith('/') || path.extname(pathname) === ''
}

async function statFile(filePath: string) {
  try {
    const stats = await fs.promises.stat(filePath)
    return stats.isFile() ? stats : null
  } catch {
    return null
  }
}

function cacheControlOf(relativePath: string) {
  // Vite が hash 付きで吐く asset だけ長期キャッシュする。
  // index.html は常に取り直させて asset hash の追従漏れを防ぐ。
  if (relativePath.startsWith(`assets${path.sep}`)) {
    return IMMUTABLE_CACHE_CONTROL
  }
  return 'no-store'
}

type SendTextOptions = {
  res: http.ServerResponse
  method: string
  status: number
  body: string
  headers?: Record<string, string>
}

function sendText({ res, method, status, body, headers }: SendTextOptions) {
  const payload = Buffer.from(`${body}\n`, 'utf8')
  res.writeHead(status, {
    ...headers,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  if (method === 'HEAD') {
    res.end()
    return
  }
  res.end(payload)
}

type SendFileOptions = {
  res: http.ServerResponse
  method: string
  root: string
  filePath: string
  size: number
}

function sendFile({ res, method, root, filePath, size }: SendFileOptions) {
  res.writeHead(200, {
    'content-type': contentTypeOf(filePath),
    'content-length': String(size),
    'cache-control': cacheControlOf(path.relative(root, filePath)),
    'x-content-type-options': 'nosniff'
  })
  if (method === 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(filePath)
  stream.on('error', () => {
    // header 送出後に読めなくなった場合は中途半端な body を残さず切る
    res.destroy()
  })
  stream.pipe(res)
}

async function readLimitedBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > REFRESH_PROXY_BODY_LIMIT_BYTES) {
      return null
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * refresh proxy は server-side の HUB_REFRESH_TOKEN を注入して Hub を叩くため、
 * CSRF(confused deputy)に耐えなければならない。ブラウザは same-origin POST
 * でも必ず Origin / Sec-Fetch-Site を付ける(非ブラウザの curl 等からは付かない)
 * ため、両者が付いていなければ fail closed で拒否する。
 */
function isSameOriginRefreshRequest(req: http.IncomingMessage) {
  const secFetchSite = req.headers['sec-fetch-site']
  if (typeof secFetchSite === 'string') {
    return secFetchSite === 'same-origin'
  }
  const origin = req.headers['origin']
  if (typeof origin !== 'string' || origin.length === 0) {
    return false
  }
  const host = req.headers['host']
  if (typeof host !== 'string' || host.length === 0) {
    return false
  }
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function proxyRefreshRequest({
  req,
  res,
  hubUrl,
  hubRefreshToken
}: {
  req: http.IncomingMessage
  res: http.ServerResponse
  hubUrl: string
  hubRefreshToken: string | null
}) {
  if (hubRefreshToken === null) {
    sendText({
      res,
      method: req.method ?? 'POST',
      status: 503,
      body: 'Refresh proxy is not configured'
    })
    return
  }

  // 他サイトからの POST は Hub を介した refresh を発行できないようにする。
  // 許可前に body を読まずに socket を切る。
  if (!isSameOriginRefreshRequest(req)) {
    res.destroy()
    return
  }

  const body = await readLimitedBody(req)
  if (body === null) {
    // 上限超過時は header を送らず接続を切断し、残りの body を read しない
    res.destroy()
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    sendText({
      res,
      method: req.method ?? 'POST',
      status: 400,
      body: 'Request body must be JSON'
    })
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendText({
      res,
      method: req.method ?? 'POST',
      status: 400,
      body: 'Request body must be a JSON object'
    })
    return
  }

  try {
    const upstream = await fetch(new URL(REFRESH_PROXY_PATH, `${hubUrl}/`), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${hubRefreshToken}`
      },
      body: body.toString('utf8'),
      signal: AbortSignal.timeout(REFRESH_PROXY_TIMEOUT_MS)
    })
    const payload = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'content-length': String(payload.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    })
    res.end(payload)
  } catch {
    sendText({
      res,
      method: req.method ?? 'POST',
      status: 502,
      body: 'Hub unavailable'
    })
  }
}

async function handleRequest({
  distDir,
  req,
  res,
  hubUrl,
  hubRefreshToken
}: {
  distDir: string
  req: http.IncomingMessage
  res: http.ServerResponse
  hubUrl: string
  hubRefreshToken: string | null
}) {
  const method = req.method ?? 'GET'
  const pathname = (req.url ?? '/').split('?')[0] ?? '/'
  if (method === 'POST' && pathname === REFRESH_PROXY_PATH) {
    await proxyRefreshRequest({ req, res, hubUrl, hubRefreshToken })
    return
  }
  if (method !== 'GET' && method !== 'HEAD') {
    sendText({
      res,
      method,
      status: 405,
      body: 'Method Not Allowed',
      headers: { allow: 'GET, HEAD' }
    })
    return
  }

  const resolved = resolveStaticPath({ distDir, requestUrl: req.url ?? '/' })
  if (!resolved.ok) {
    sendText({ res, method, status: 400, body: 'Bad Request' })
    return
  }

  const root = path.resolve(distDir)
  const stats = await statFile(resolved.filePath)
  if (stats) {
    sendFile({ res, method, root, filePath: resolved.filePath, size: stats.size })
    return
  }

  if (!shouldFallbackToIndex(resolved.pathname)) {
    sendText({ res, method, status: 404, body: 'Not Found' })
    return
  }

  const indexPath = path.join(root, 'index.html')
  const indexStats = await statFile(indexPath)
  if (!indexStats) {
    sendText({ res, method, status: 404, body: 'Not Found' })
    return
  }
  sendFile({ res, method, root, filePath: indexPath, size: indexStats.size })
}

/**
 * Vite の build 出力(dist/public)を配信する本番 server。
 * 外部依存を持たず node:http だけで構成する。
 */
export function createStaticServer({
  distDir,
  hubUrl = 'http://127.0.0.1:8787',
  hubRefreshToken = null
}: {
  distDir: string
  hubUrl?: string
  hubRefreshToken?: string | null
}) {
  return http.createServer((req, res) => {
    handleRequest({ distDir, req, res, hubUrl, hubRefreshToken }).catch(() => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendText({ res, method: req.method ?? 'GET', status: 500, body: 'Internal Server Error' })
    })
  })
}

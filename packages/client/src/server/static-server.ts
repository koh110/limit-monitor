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

async function handleRequest({
  distDir,
  req,
  res
}: {
  distDir: string
  req: http.IncomingMessage
  res: http.ServerResponse
}) {
  const method = req.method ?? 'GET'
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
export function createStaticServer({ distDir }: { distDir: string }) {
  return http.createServer((req, res) => {
    handleRequest({ distDir, req, res }).catch(() => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendText({ res, method: req.method ?? 'GET', status: 500, body: 'Internal Server Error' })
    })
  })
}

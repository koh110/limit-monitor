import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vite-plus/test'
import { contentTypeOf, createStaticServer, resolveStaticPath } from './static-server.js'

type Response = {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/** dist/public 相当の fixture を作る。test ごとに独立した一時 dir を使う */
function createDist() {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-dashboard-'))
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>dashboard</title>')
  fs.mkdirSync(path.join(distDir, 'assets'))
  fs.writeFileSync(path.join(distDir, 'assets', 'app-abcdef.js'), 'export const app = 1\n')
  fs.writeFileSync(path.join(distDir, 'assets', 'app-abcdef.css'), 'body{margin:0}\n')
  fs.writeFileSync(path.join(distDir, 'favicon.ico'), 'icon')
  fs.writeFileSync(path.join(distDir, 'unknown.bin'), 'binary')
  return distDir
}

function request({
  port,
  requestPath,
  method = 'GET',
  headers,
  body
}: {
  port: number
  requestPath: string
  method?: string
  headers?: Record<string, string>
  body?: string
}) {
  return new Promise<Response>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method, headers },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** 一時 dist を配信する server を起動し、終了時に必ず片付ける */
async function withServer(
  run: (port: number) => Promise<void>,
  options: { hubUrl?: string; hubRefreshToken?: string | null } = {}
) {
  const distDir = createDist()
  const server = createStaticServer({
    distDir,
    hubUrl: options.hubUrl,
    hubRefreshToken: options.hubRefreshToken
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port')
  }
  try {
    await run(address.port)
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    fs.rmSync(distDir, { recursive: true, force: true })
  }
}

test('root は index.html を no-store で返す', async () => {
  await withServer(async (port) => {
    const res = await request({ port, requestPath: '/' })
    expect(res.status).toBe(200)
    expect(res.body).toContain('dashboard')
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
  })
})

test('存在する asset は拡張子どおりの Content-Type と長期キャッシュで返す', async () => {
  await withServer(async (port) => {
    const js = await request({ port, requestPath: '/assets/app-abcdef.js' })
    expect(js.status).toBe(200)
    expect(js.body).toContain('export const app')
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable')

    const css = await request({ port, requestPath: '/assets/app-abcdef.css' })
    expect(css.status).toBe(200)
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8')

    const ico = await request({ port, requestPath: '/favicon.ico' })
    expect(ico.status).toBe(200)
    expect(ico.headers['content-type']).toBe('image/x-icon')
    expect(ico.headers['cache-control']).toBe('no-store')
  })
})

test('未知の拡張子は sniff させず octet-stream にする', async () => {
  await withServer(async (port) => {
    const res = await request({ port, requestPath: '/unknown.bin' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})

test('SPA route は index.html を 200 で返す', async () => {
  await withServer(async (port) => {
    for (const requestPath of ['/dashboard', '/dashboard/', '/a/b/c', '/dashboard?refresh=1']) {
      const res = await request({ port, requestPath })
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(res.body).toContain('dashboard')
    }
  })
})

test('存在しない asset は SPA fallback せず 404 にする', async () => {
  await withServer(async (port) => {
    for (const requestPath of [
      '/assets/missing-123456.js',
      '/missing.css',
      '/missing.png',
      '/index.htm'
    ]) {
      const res = await request({ port, requestPath })
      expect(res.status).toBe(404)
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
      expect(res.body).not.toContain('dashboard')
    }
  })
})

test('dist の外へ出る path は 400 で拒否し index.html も返さない', async () => {
  await withServer(async (port) => {
    for (const requestPath of [
      '/../../../../etc/passwd',
      '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
      '/assets/../../../../etc/passwd',
      '/..%2f..%2f..%2fetc%2fpasswd',
      '/%2e%2e%2f%2e%2e%2fetc%2fshadow',
      '/assets/..%5c..%5cetc%5cpasswd'
    ]) {
      const res = await request({ port, requestPath })
      expect(res.status).toBe(400)
      expect(res.body).not.toContain('root:')
      expect(res.body).not.toContain('dashboard')
    }
  })
})

test('GET / HEAD 以外は 405 にする', async () => {
  await withServer(async (port) => {
    const res = await request({ port, requestPath: '/', method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers['allow']).toBe('GET, HEAD')
  })
})

test('HEAD は header だけを返す', async () => {
  await withServer(async (port) => {
    const res = await request({ port, requestPath: '/assets/app-abcdef.js', method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(res.body).toBe('')
  })
})

test('Dashboard の same-origin refresh POST は Hub へ server-side Bearer 転送する', async () => {
  const upstream = vi.fn(async (input: URL, init?: RequestInit) => {
    expect(input.toString()).toBe('http://hub.test/api/v1/refresh-requests')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      Authorization: 'Bearer dashboard-secret'
    })
    expect(init?.body).toBe('{"provider":"codex","accountAlias":"main"}')
    return new Response('{"requestId":"request-1","status":"queued"}', {
      status: 202,
      headers: { 'content-type': 'application/json' }
    })
  })
  vi.stubGlobal('fetch', upstream)
  try {
    await withServer(
      async (port) => {
        const response = await request({
          port,
          requestPath: '/api/v1/refresh-requests',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: `http://127.0.0.1:${port}`
          },
          body: '{"provider":"codex","accountAlias":"main"}'
        })
        expect(response.status).toBe(202)
        expect(response.body).toContain('request-1')
      },
      { hubUrl: 'http://hub.test', hubRefreshToken: 'dashboard-secret' }
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

test('他サイトからの refresh POST は Hub へ送らず接続を切る', async () => {
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  try {
    await withServer(
      async (port) => {
        await expect(
          request({
            port,
            requestPath: '/api/v1/refresh-requests',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'http://evil.example'
            },
            body: '{"provider":"codex","accountAlias":"main"}'
          })
        ).rejects.toThrow()
        expect(upstream).not.toHaveBeenCalled()
      },
      { hubUrl: 'http://hub.test', hubRefreshToken: 'dashboard-secret' }
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

test('Origin と Sec-Fetch-Site がない refresh POST は Hub へ送らず接続を切る', async () => {
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  try {
    await withServer(
      async (port) => {
        await expect(
          request({
            port,
            requestPath: '/api/v1/refresh-requests',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
          })
        ).rejects.toThrow()
        expect(upstream).not.toHaveBeenCalled()
      },
      { hubUrl: 'http://hub.test', hubRefreshToken: 'dashboard-secret' }
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

test('refresh body が上限を超えると header を送らず接続を切る', async () => {
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  try {
    await withServer(
      async (port) => {
        await expect(
          request({
            port,
            requestPath: '/api/v1/refresh-requests',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: `http://127.0.0.1:${port}`
            },
            body: JSON.stringify({
              provider: 'codex',
              accountAlias: 'main',
              padding: 'x'.repeat(8 * 1024)
            })
          })
        ).rejects.toThrow()
        expect(upstream).not.toHaveBeenCalled()
      },
      { hubUrl: 'http://hub.test', hubRefreshToken: 'dashboard-secret' }
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

test('JSON でない refresh body は 400 で Hub へ送らない', async () => {
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  try {
    await withServer(
      async (port) => {
        const response = await request({
          port,
          requestPath: '/api/v1/refresh-requests',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: `http://127.0.0.1:${port}`
          },
          body: 'not-json'
        })
        expect(response.status).toBe(400)
        expect(upstream).not.toHaveBeenCalled()
      },
      { hubUrl: 'http://hub.test', hubRefreshToken: 'dashboard-secret' }
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

test('Dashboard proxy は token 未設定時にHubへ送らず503を返す', async () => {
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  try {
    await withServer(
      async (port) => {
        const response = await request({
          port,
          requestPath: '/api/v1/refresh-requests',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        })
        expect(response.status).toBe(503)
        expect(upstream).not.toHaveBeenCalled()
      },
      { hubUrl: 'http://hub.test', hubRefreshToken: null }
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

test('resolveStaticPath は root 配下だけを返す', () => {
  const distDir = '/srv/app/dist/public'
  expect(resolveStaticPath({ distDir, requestUrl: '/assets/a.js' })).toEqual({
    ok: true,
    pathname: '/assets/a.js',
    filePath: '/srv/app/dist/public/assets/a.js'
  })
  // query / fragment は落としてから解決する
  expect(resolveStaticPath({ distDir, requestUrl: '/dashboard?refresh=1#top' })).toEqual({
    ok: true,
    pathname: '/dashboard',
    filePath: '/srv/app/dist/public/dashboard'
  })
  // `..` は raw / encoded の別なく、root 内へ戻る場合も含めて拒否する
  for (const requestUrl of [
    '/../secrets.env',
    '/assets/../index.html',
    '/../public-backup/a.js',
    '/%2e%2e/secrets.env',
    '/assets/%2E%2E/%2e%2e/etc/passwd',
    '/..%2fsecrets.env'
  ]) {
    expect(resolveStaticPath({ distDir, requestUrl })).toEqual({
      ok: false,
      reason: 'traversal'
    })
  }
  for (const requestUrl of [
    '//evil.example/a.js',
    'assets/a.js',
    '/a\\..\\b',
    '/a%00.js',
    '/a%ZZ'
  ]) {
    expect(resolveStaticPath({ distDir, requestUrl })).toEqual({
      ok: false,
      reason: 'invalid_url'
    })
  }
})

test('contentTypeOf は既知の拡張子を大文字小文字なく解決する', () => {
  expect(contentTypeOf('/x/index.HTML')).toBe('text/html; charset=utf-8')
  expect(contentTypeOf('/x/a.woff2')).toBe('font/woff2')
  expect(contentTypeOf('/x/a.svg')).toBe('image/svg+xml')
  expect(contentTypeOf('/x/a.unknown')).toBe('application/octet-stream')
  expect(contentTypeOf('/x/noext')).toBe('application/octet-stream')
})

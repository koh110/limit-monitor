import { expect, test } from 'vite-plus/test'
import { createTestDb } from '../test/util.js'
import { createApp } from './app.js'

const ALLOWED_ORIGIN = 'http://localhost:5173'
const DENIED_ORIGIN = 'http://evil.example.com'

test('許可された origin からの GET には Access-Control-Allow-Origin と Vary: Origin が付く', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, corsAllowedOrigins: [ALLOWED_ORIGIN] })
  const res = await app.request('/api/v1/status', {
    headers: { Origin: ALLOWED_ORIGIN }
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN)
  expect(res.headers.get('Vary')).toContain('Origin')
  cleanup()
})

test('許可されていない origin からの GET には Access-Control-Allow-Origin が付かない', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, corsAllowedOrigins: [ALLOWED_ORIGIN] })
  const res = await app.request('/api/v1/status', {
    headers: { Origin: DENIED_ORIGIN }
  })
  // CORS は browser 側で block する仕組みのため、response 自体は 200 のままヘッダーで拒否を表現する
  expect(res.status).toBe(200)
  expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  expect(res.headers.get('Vary')).toContain('Origin')
  cleanup()
})

test('Origin header がないリクエスト(collector 等)には CORS ヘッダーを付けない', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, corsAllowedOrigins: [ALLOWED_ORIGIN] })
  const res = await app.request('/api/v1/status')
  expect(res.status).toBe(200)
  expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  cleanup()
})

test('許可 origin からの preflight (OPTIONS) は 204 と Allow ヘッダーを返す', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, corsAllowedOrigins: [ALLOWED_ORIGIN] })
  const res = await app.request('/api/v1/status', {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'GET'
    }
  })
  expect(res.status).toBe(204)
  expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN)
  expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
  expect(res.headers.get('Vary')).toContain('Origin')
  cleanup()
})

test('denied origin からの preflight (OPTIONS) は Allow-Origin なしで返す', async () => {
  const { db, cleanup } = createTestDb()
  const app = createApp({ db, corsAllowedOrigins: [ALLOWED_ORIGIN] })
  const res = await app.request('/api/v1/status', {
    method: 'OPTIONS',
    headers: {
      Origin: DENIED_ORIGIN,
      'Access-Control-Request-Method': 'GET'
    }
  })
  expect(res.status).toBe(204)
  expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  expect(res.headers.get('Vary')).toContain('Origin')
  cleanup()
})

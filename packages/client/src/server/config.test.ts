import { beforeEach, expect, test, vi } from 'vite-plus/test'

/**
 * server/config.ts は環境変数をモジュール読み込み時に評価するため、
 * 各 test で env を変えてから resetModules + 再 import で評価し直す。
 */
const ENV_KEYS = ['HOST', 'PORT', 'DASHBOARD_PUBLIC_ORIGIN', 'DASHBOARD_DIST_DIR'] as const

function setEnv(env: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = env[key]
    }
  }
}

async function loadConfig() {
  vi.resetModules()
  return import('./config.js')
}

beforeEach(() => {
  vi.resetModules()
})

test('既定は localhost bind / port 8788 であり public origin も localhost 由来', async () => {
  setEnv({})
  const { HOST, PORT, DASHBOARD_PUBLIC_ORIGIN } = await loadConfig()
  expect(HOST).toBe('127.0.0.1')
  expect(PORT).toBe(8788)
  expect(DASHBOARD_PUBLIC_ORIGIN).toBe('http://127.0.0.1:8788')
})

test('bind address(HOST)と public origin は分離できる', async () => {
  setEnv({
    HOST: '127.0.0.1',
    PORT: '3100',
    DASHBOARD_PUBLIC_ORIGIN: 'http://limit-monitor.local:3100'
  })
  const { HOST, PORT, DASHBOARD_PUBLIC_ORIGIN } = await loadConfig()
  expect(HOST).toBe('127.0.0.1')
  expect(PORT).toBe(3100)
  expect(DASHBOARD_PUBLIC_ORIGIN).toBe('http://limit-monitor.local:3100')
})

test('localhost bind の場合は public origin 未指定でも HOST/PORT 由来で導出する', async () => {
  setEnv({ HOST: 'localhost', PORT: '3000' })
  const { DASHBOARD_PUBLIC_ORIGIN } = await loadConfig()
  expect(DASHBOARD_PUBLIC_ORIGIN).toBe('http://localhost:3000')
})

test('LAN bind(0.0.0.0)で public origin 未指定なら起動時に落とす', async () => {
  setEnv({ HOST: '0.0.0.0' })
  await expect(loadConfig()).rejects.toThrow(
    /DASHBOARD_PUBLIC_ORIGIN must be set when HOST=0\.0\.0\.0/
  )
})

test('LAN bind(LAN IP)で public origin 未指定なら起動時に落とす', async () => {
  setEnv({ HOST: '192.168.1.10' })
  await expect(loadConfig()).rejects.toThrow(/DASHBOARD_PUBLIC_ORIGIN must be set/)
})

test('LAN bind(0.0.0.0) + public origin 指定ならそのまま使う', async () => {
  setEnv({
    HOST: '0.0.0.0',
    DASHBOARD_PUBLIC_ORIGIN: 'http://limit-monitor.lan:3000'
  })
  const { HOST, DASHBOARD_PUBLIC_ORIGIN } = await loadConfig()
  expect(HOST).toBe('0.0.0.0')
  expect(DASHBOARD_PUBLIC_ORIGIN).toBe('http://limit-monitor.lan:3000')
})

test('不正な public origin(http/https 以外)は起動時に落とす', async () => {
  setEnv({ DASHBOARD_PUBLIC_ORIGIN: 'ftp://example.com:3000' })
  await expect(loadConfig()).rejects.toThrow(/DASHBOARD_PUBLIC_ORIGIN must be an origin/)
})

test('不正な public origin(pathname/search/hash/userinfo/末尾スラッシュ)は起動時に落とす', async () => {
  // http(s)://host[:port] のみ受理。pathname / search / hash / userinfo /
  // 末尾スラッシュは拒否(末尾スラッシュは Hub の Origin exact match と不一致)
  const badOrigins = [
    'http://example.com/path',
    'http://example.com:3000?x=1',
    'http://example.com:3000#frag',
    'http://user:pass@example.com:3000',
    'http://example.com:70000',
    'http://example.com:0',
    'https://example.com/'
  ]
  for (const bad of badOrigins) {
    setEnv({ DASHBOARD_PUBLIC_ORIGIN: bad })
    await expect(loadConfig(), bad).rejects.toThrow(/DASHBOARD_PUBLIC_ORIGIN must be an origin/)
  }
  // 正: pathname なし / 任意 port は受理
  const goodOrigins = ['http://example.com', 'https://example.com', 'http://example.com:8443']
  for (const good of goodOrigins) {
    setEnv({ DASHBOARD_PUBLIC_ORIGIN: good })
    const { DASHBOARD_PUBLIC_ORIGIN } = await loadConfig()
    expect(DASHBOARD_PUBLIC_ORIGIN, good).toBe(good)
  }
})

test('PORT が不正なら従来どおり起動時に落とす', async () => {
  setEnv({ PORT: 'not-a-port' })
  await expect(loadConfig()).rejects.toThrow(/PORT must be an integer/)
})

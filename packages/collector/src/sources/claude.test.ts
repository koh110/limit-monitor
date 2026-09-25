import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vite-plus/test'
import { createClaudeReader } from './claude.js'

const INPUT = { sourceId: 'dev-machine', observedAt: '2026-09-01T11:36:47.683Z' }

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function createTestFiles() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-claude-test-'))
  const credentialsFile = path.join(directory, 'credentials.json')
  const cacheFile = path.join(directory, 'usage-cache.json')
  cleanups.push(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { credentialsFile, cacheFile }
}

async function createUsageServer({
  statusCode = 200,
  statusCodes,
  body
}: {
  statusCode?: number
  statusCodes?: number[]
  body: unknown
}) {
  let requestCount = 0
  let authorization = ''
  let userAgent = ''
  const server = createServer((request, response) => {
    requestCount += 1
    authorization = request.headers.authorization ?? ''
    userAgent = request.headers['user-agent'] ?? ''
    response.statusCode = statusCodes?.[requestCount - 1] ?? statusCode
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('test usage server did not expose a TCP address')
  }
  cleanups.push(() => {
    server.close()
  })
  return {
    url: `http://127.0.0.1:${address.port}/api/oauth/usage`,
    requestCount: () => requestCount,
    authorization: () => authorization,
    userAgent: () => userAgent
  }
}

async function createTokenServer({
  body,
  statusCode = 200,
  onRequest
}: {
  body: unknown
  statusCode?: number
  onRequest?: () => void
}) {
  let requestBody = ''
  let anthropicBeta = ''
  const server = createServer((request, response) => {
    const header = request.headers['anthropic-beta']
    anthropicBeta = Array.isArray(header) ? (header[0] ?? '') : (header ?? '')
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requestBody = Buffer.concat(chunks).toString('utf8')
      onRequest?.()
      response.statusCode = statusCode
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('test token server did not expose a TCP address')
  }
  cleanups.push(() => server.close())
  return {
    url: `http://127.0.0.1:${address.port}/v1/oauth/token`,
    requestBody: () => requestBody,
    anthropicBeta: () => anthropicBeta
  }
}

function writeCredentials(file: string, accessToken: string, oauth: Record<string, unknown> = {}) {
  fs.writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        scopes: ['user:profile', 'user:inference'],
        accessToken,
        ...oauth
      }
    })
  )
  fs.chmodSync(file, 0o600)
}

function usageReader({
  credentialsFile,
  cacheFile,
  usageUrl,
  now = () => Date.parse(INPUT.observedAt),
  cacheTtlMs = 300_000,
  userAgent,
  tokenUrl
}: {
  credentialsFile: string
  cacheFile: string
  usageUrl: string
  now?: () => number
  cacheTtlMs?: number
  userAgent?: string
  tokenUrl?: string
}) {
  return createClaudeReader({
    credentialsFile,
    usageUrl,
    tokenUrl,
    cacheFile,
    cacheTtlMs,
    timeoutMs: 10_000,
    maxResponseBytes: 1024 * 1024,
    userAgent,
    now
  })
}

test('OAuth usage API の実測形式から Observation を作る', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  writeCredentials(credentialsFile, 'token-for-test')
  const server = await createUsageServer({
    body: {
      five_hour: { utilization: 11, resets_at: '2026-09-01T12:19:00.000Z' },
      seven_day: { utilization: 13, resets_at: '2026-09-06T11:59:00.000Z' },
      seven_day_opus: { utilization: 16, resets_at: '2026-09-06T11:59:00.000Z' },
      extra_usage: { is_enabled: true, utilization: null }
    }
  })
  const result = await usageReader({ credentialsFile, cacheFile, usageUrl: server.url })(INPUT)
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error('expected usage API success')
  }
  expect(result.observation.provider).toBe('claude')
  expect(result.observation.observedAt).toBe(INPUT.observedAt)
  expect(result.observation.buckets).toEqual([
    {
      bucketId: 'claude:session',
      label: '5h',
      usedPercent: 11,
      remainingPercent: 89,
      windowDurationSeconds: 18000,
      resetsAt: '2026-09-01T12:19:00.000Z',
      reached: false
    },
    {
      bucketId: 'claude:week',
      label: '7d',
      usedPercent: 13,
      remainingPercent: 87,
      windowDurationSeconds: 604800,
      resetsAt: '2026-09-06T11:59:00.000Z',
      reached: false
    },
    {
      bucketId: 'claude:week:opus',
      label: '7d Opus',
      usedPercent: 16,
      remainingPercent: 84,
      windowDurationSeconds: 604800,
      resetsAt: '2026-09-06T11:59:00.000Z',
      reached: false
    }
  ])
  expect(server.authorization()).toBe('Bearer token-for-test')
  expect(fs.readFileSync(cacheFile, 'utf8')).not.toContain('token-for-test')
})

test('既定 User-Agent は Claude Code client identity を使う', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  writeCredentials(credentialsFile, 'token-for-test')
  const server = await createUsageServer({
    body: { five_hour: { utilization: 11 } }
  })
  const result = await usageReader({ credentialsFile, cacheFile, usageUrl: server.url })(INPUT)
  expect(result.ok).toBe(true)
  expect(server.userAgent()).toBe('claude-code/2.1.282')
})

test('期限切れの access token は OAuth refresh で更新し、rotation された token を保存する', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  const now = Date.parse(INPUT.observedAt)
  writeCredentials(credentialsFile, 'expired-access-token', {
    refreshToken: 'refresh-token-for-test',
    expiresAt: now - 1,
    refreshTokenExpiresAt: now + 30 * 24 * 60 * 60 * 1000
  })
  const tokenServer = await createTokenServer({
    body: {
      access_token: 'refreshed-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_in: 3600,
      refresh_token_expires_in: 86400
    }
  })
  const usageServer = await createUsageServer({
    body: { five_hour: { utilization: 11 } }
  })
  const result = await usageReader({
    credentialsFile,
    cacheFile,
    usageUrl: usageServer.url,
    tokenUrl: tokenServer.url,
    now: () => now
  })(INPUT)
  expect(result.ok).toBe(true)
  expect(JSON.parse(tokenServer.requestBody())).toMatchObject({
    grant_type: 'refresh_token',
    refresh_token: 'refresh-token-for-test',
    client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scope: 'user:profile user:inference'
  })
  expect(tokenServer.anthropicBeta()).toBe('oauth-2025-04-20')
  expect(usageServer.authorization()).toBe('Bearer refreshed-access-token')
  const persisted = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'))
  expect(persisted.claudeAiOauth).toMatchObject({
    accessToken: 'refreshed-access-token',
    refreshToken: 'rotated-refresh-token',
    expiresAt: now + 3_600_000,
    refreshTokenExpiresAt: now + 86_400_000
  })
  expect(fs.readFileSync(cacheFile, 'utf8')).not.toContain('rotated-refresh-token')
})

test('refresh response に不正な refresh token expiry があれば fail-closed する', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  const now = Date.parse(INPUT.observedAt)
  writeCredentials(credentialsFile, 'expired-access-token', {
    refreshToken: 'refresh-token-for-test',
    expiresAt: now - 1,
    refreshTokenExpiresAt: now + 30 * 24 * 60 * 60 * 1000
  })
  const tokenServer = await createTokenServer({
    body: {
      access_token: 'refreshed-access-token',
      expires_in: 3600,
      refresh_token_expires_in: 0
    }
  })
  const usageServer = await createUsageServer({
    body: { five_hour: { utilization: 11 } }
  })
  const result = await usageReader({
    credentialsFile,
    cacheFile,
    usageUrl: usageServer.url,
    tokenUrl: tokenServer.url,
    now: () => now
  })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'credentials_refresh_invalid_response' })
  expect(usageServer.requestCount()).toBe(0)
})

test('起動時に中断された credentials swap の journal から displaced inode を復旧する', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  const displacedFile = `${credentialsFile}.dead.displaced`
  const temporaryFile = `${credentialsFile}.dead.tmp`
  const guardFile = `${credentialsFile}.dead.guard`
  fs.writeFileSync(
    displacedFile,
    JSON.stringify({
      claudeAiOauth: {
        scopes: ['user:profile'],
        accessToken: 'recovered-access-token'
      }
    })
  )
  fs.chmodSync(displacedFile, 0o600)
  const journalFile = `${credentialsFile}.limit-monitor.swap`
  const lockFile = `${credentialsFile}.limit-monitor.lock`
  fs.writeFileSync(
    journalFile,
    JSON.stringify({
      pid: 2_147_483_647,
      temporaryFile,
      guardFile,
      displacedFile
    })
  )
  fs.chmodSync(journalFile, 0o600)
  fs.writeFileSync(lockFile, '2147483647.dead-owner')
  fs.chmodSync(lockFile, 0o600)
  const usageServer = await createUsageServer({
    body: { five_hour: { utilization: 11 } }
  })
  const result = await usageReader({
    credentialsFile,
    cacheFile,
    usageUrl: usageServer.url,
    now: () => Date.parse(INPUT.observedAt)
  })(INPUT)
  expect(result.ok).toBe(true)
  expect(fs.existsSync(journalFile)).toBe(false)
  expect(fs.existsSync(lockFile)).toBe(false)
  expect(fs.existsSync(displacedFile)).toBe(false)
})

test('refresh 中に credentials が外部更新された場合は古い token で上書きしない', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  const now = Date.parse(INPUT.observedAt)
  writeCredentials(credentialsFile, 'expired-access-token', {
    refreshToken: 'refresh-token-for-test',
    expiresAt: now - 1,
    refreshTokenExpiresAt: now + 30 * 24 * 60 * 60 * 1000
  })
  const tokenServer = await createTokenServer({
    body: {
      access_token: 'refreshed-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_in: 3600
    },
    onRequest: () =>
      writeCredentials(credentialsFile, 'external-access-token', {
        refreshToken: 'external-refresh-token',
        expiresAt: now + 3600_000
      })
  })
  const usageServer = await createUsageServer({
    body: { five_hour: { utilization: 11 } }
  })
  const result = await usageReader({
    credentialsFile,
    cacheFile,
    usageUrl: usageServer.url,
    tokenUrl: tokenServer.url,
    now: () => now
  })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'credentials_persist_failed' })
  expect(usageServer.requestCount()).toBe(0)
  expect(JSON.parse(fs.readFileSync(credentialsFile, 'utf8')).claudeAiOauth).toMatchObject({
    accessToken: 'external-access-token',
    refreshToken: 'external-refresh-token'
  })
})

test('usage API の 401 後は refresh 済み token で一度だけ再試行する', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  const now = Date.parse(INPUT.observedAt)
  writeCredentials(credentialsFile, 'current-access-token', {
    refreshToken: 'refresh-token-for-retry',
    expiresAt: now + 24 * 60 * 60 * 1000,
    refreshTokenExpiresAt: now + 30 * 24 * 60 * 60 * 1000
  })
  const tokenServer = await createTokenServer({
    body: {
      access_token: 'current-access-token',
      refresh_token: 'rotated-retry-token',
      expires_in: 3600,
      refresh_token_expires_in: 86400
    }
  })
  const usageServer = await createUsageServer({
    statusCodes: [401, 200],
    body: { five_hour: { utilization: 11 } }
  })
  const result = await usageReader({
    credentialsFile,
    cacheFile,
    usageUrl: usageServer.url,
    tokenUrl: tokenServer.url,
    now: () => now
  })(INPUT)
  expect(result.ok).toBe(true)
  expect(usageServer.requestCount()).toBe(2)
  expect(usageServer.authorization()).toBe('Bearer current-access-token')
  expect(JSON.parse(tokenServer.requestBody())).toMatchObject({
    refresh_token: 'refresh-token-for-retry',
    scope: 'user:profile user:inference'
  })
})

test('新しい limits[] 形式の API 応答も Observation にする', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  writeCredentials(credentialsFile, 'token-for-test')
  const server = await createUsageServer({
    body: {
      five_hour: null,
      seven_day: null,
      limits: [
        { kind: 'session', percent: 4, resets_at: '2026-09-01T12:19:00.000Z', scope: null },
        { kind: 'weekly_all', percent: 18, resets_at: '2026-09-06T11:59:00.000Z', scope: null },
        {
          kind: 'weekly_scoped',
          percent: 23,
          resets_at: '2026-09-06T11:59:00.000Z',
          scope: { model: { display_name: 'Fable' } }
        }
      ]
    }
  })
  const result = await usageReader({ credentialsFile, cacheFile, usageUrl: server.url })(INPUT)
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error('expected limits[] usage API success')
  }
  expect(result.observation.buckets).toEqual([
    expect.objectContaining({ bucketId: 'claude:session', usedPercent: 4 }),
    expect.objectContaining({ bucketId: 'claude:week', usedPercent: 18 }),
    expect.objectContaining({
      bucketId: 'claude:week:fable-6489664b94f0ae56869e719ec024e1b5',
      usedPercent: 23
    })
  ])
})

test('cache TTL 内は OAuth usage API を再度呼ばない', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  writeCredentials(credentialsFile, 'token-for-test')
  const server = await createUsageServer({
    body: {
      five_hour: { utilization: 20, resets_at: '2026-09-01T12:19:00.000Z' }
    }
  })
  let now = Date.parse(INPUT.observedAt)
  const reader = usageReader({
    credentialsFile,
    cacheFile,
    usageUrl: server.url,
    now: () => now
  })
  const first = await reader(INPUT)
  now += 60_000
  const second = await reader({ ...INPUT, observedAt: '2026-09-01T11:37:47.683Z' })
  expect(first.ok).toBe(true)
  expect(second.ok).toBe(true)
  expect(server.requestCount()).toBe(1)
  if (!second.ok) {
    throw new Error('expected cached usage success')
  }
  expect(second.observation.observedAt).toBe(INPUT.observedAt)
})

test('cache TTL 超過後は OAuth usage API を再取得する', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  writeCredentials(credentialsFile, 'token-for-test')
  const server = await createUsageServer({
    body: {
      five_hour: { utilization: 20, resets_at: '2026-09-01T12:19:00.000Z' }
    }
  })
  let now = Date.parse(INPUT.observedAt)
  const reader = usageReader({
    credentialsFile,
    cacheFile,
    usageUrl: server.url,
    now: () => now,
    cacheTtlMs: 1_000
  })
  expect((await reader(INPUT)).ok).toBe(true)
  now += 2_000
  expect((await reader({ ...INPUT, observedAt: '2026-09-01T11:36:49.683Z' })).ok).toBe(true)
  expect(server.requestCount()).toBe(2)
})

test('API の rate limit failure 中は backoff で毎分 polling しない', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  writeCredentials(credentialsFile, 'token-for-test')
  const server = await createUsageServer({ statusCode: 429, body: { error: 'rate_limited' } })
  let now = Date.parse(INPUT.observedAt)
  const reader = usageReader({
    credentialsFile,
    cacheFile,
    usageUrl: server.url,
    now: () => now,
    cacheTtlMs: 1_000
  })
  expect((await reader(INPUT)).ok).toBe(false)
  now += 500
  expect(await reader(INPUT)).toMatchObject({ ok: false, reason: 'usage_api_backoff' })
  expect(server.requestCount()).toBe(1)
})

test('OAuth access token が無ければ API を呼ばず失敗する', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  writeCredentials(credentialsFile, '')
  const server = await createUsageServer({
    body: {
      five_hour: { utilization: 20 }
    }
  })
  const result = await usageReader({ credentialsFile, cacheFile, usageUrl: server.url })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'missing_access_token' })
  expect(server.requestCount()).toBe(0)
})

test('OAuth credentials に usage scope が無ければ API を呼ばず失敗する', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  writeCredentials(credentialsFile, 'token-without-profile-scope', {
    scopes: ['user:inference']
  })
  const server = await createUsageServer({
    body: { five_hour: { utilization: 20 } }
  })
  const result = await usageReader({ credentialsFile, cacheFile, usageUrl: server.url })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'missing_usage_scope' })
  expect(server.requestCount()).toBe(0)
})

test('OAuth usage API の HTTP エラーは fake 値へ fallback しない', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  writeCredentials(credentialsFile, 'token-for-test')
  const server = await createUsageServer({
    statusCode: 401,
    body: { error: { type: 'authentication_error', message: 'expired' } }
  })
  const result = await usageReader({ credentialsFile, cacheFile, usageUrl: server.url })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'usage_api_auth_failed' })
})

test('rate limit window が無い API 応答は失敗として扱う', async () => {
  const { credentialsFile, cacheFile } = createTestFiles()
  writeCredentials(credentialsFile, 'token-for-test')
  const server = await createUsageServer({
    body: {
      extra_usage: { is_enabled: true, utilization: null }
    }
  })
  const result = await usageReader({ credentialsFile, cacheFile, usageUrl: server.url })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'no_rate_limits' })
})

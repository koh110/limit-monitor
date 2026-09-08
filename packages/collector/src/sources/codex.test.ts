import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'vite-plus/test'
import { createCodexReader } from './codex.js'
import { createFakeBinary } from './test-binary.js'

const INPUT = { sourceId: 'dev-machine', observedAt: '2026-09-01T11:36:47.683Z' }

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function fakeCodex(source: string): { command: string; dir: string } {
  const binary = createFakeBinary(source)
  cleanups.push(binary.cleanup)
  return { command: binary.command, dir: binary.dir }
}

function reader({
  command,
  timeoutMs = 10_000,
  maxStdoutBytes = 1024 * 1024
}: {
  command: string
  timeoutMs?: number
  maxStdoutBytes?: number
}) {
  return createCodexReader({ command, timeoutMs, maxStdoutBytes, clientVersion: '0.1.0' })
}

// 実測の app-server と同じ順序(notification 割り込みを含む)で応答する fake
const FAKE_APP_SERVER = `
  import readline from 'node:readline'
  process.stderr.write('sandbox warning noise\\n')
  const rl = readline.createInterface({ input: process.stdin })
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
  rl.on('line', (line) => {
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { userAgent: 'fake', codexHome: '/tmp' } })
      send({ method: 'configWarning', params: { summary: 'noise' } })
      send({ method: 'remoteControl/status/changed', params: { status: 'disabled' } })
      return
    }
    if (msg.method === 'account/rateLimits/read') {
      send({
        id: msg.id,
        result: {
          rateLimits: {
            limitId: 'codex',
            limitName: null,
            primary: { usedPercent: 13, windowDurationMins: 300, resetsAt: 1788274954 },
            secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1788747931 },
            credits: { hasCredits: false, balance: '0' },
            planType: 'plus'
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: 'codex',
              primary: { usedPercent: 13, windowDurationMins: 300, resetsAt: 1788274954 },
              secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1788747931 }
            }
          }
        }
      })
    }
  })
`

test('app-server の実測応答から Observation を作る', async () => {
  const result = await reader({ command: fakeCodex(FAKE_APP_SERVER).command })(INPUT)
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error('expected success')
  }
  expect(result.observation.provider).toBe('codex')
  expect(result.observation.buckets).toEqual([
    {
      bucketId: 'codex:codex:primary',
      label: '5h',
      usedPercent: 13,
      remainingPercent: 87,
      windowDurationSeconds: 18000,
      // unix 秒が ISO へ正規化される
      resetsAt: '2026-09-01T15:02:34.000Z',
      reached: false
    },
    {
      bucketId: 'codex:codex:secondary',
      label: '7d',
      usedPercent: 27,
      remainingPercent: 73,
      windowDurationSeconds: 604800,
      resetsAt: '2026-09-07T02:25:31.000Z',
      reached: false
    }
  ])
})

test('initialize → initialized → account/rateLimits/read の順で送る', async () => {
  const { command, dir } = fakeCodex(`
    import fs from 'node:fs'
    import path from 'node:path'
    import readline from 'node:readline'
    const seen = []
    const rl = readline.createInterface({ input: process.stdin })
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
    rl.on('line', (line) => {
      const msg = JSON.parse(line)
      seen.push(msg.method)
      fs.writeFileSync(path.join(import.meta.dirname, 'seen.json'), JSON.stringify(seen))
      if (msg.method === 'initialize') {
        send({ id: msg.id, result: {} })
        return
      }
      if (msg.method === 'account/rateLimits/read') {
        send({ id: msg.id, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 1 } } } })
      }
    })
  `)
  const result = await reader({ command })(INPUT)
  expect(result.ok).toBe(true)
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'))).toEqual([
    'initialize',
    'initialized',
    'account/rateLimits/read'
  ])
})

test('app-server の error 応答は失敗として扱う(fixture へ落ちない)', async () => {
  const { command } = fakeCodex(`
    import readline from 'node:readline'
    const rl = readline.createInterface({ input: process.stdin })
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
    rl.on('line', (line) => {
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') {
        send({ id: msg.id, result: {} })
        return
      }
      send({ id: msg.id, error: { code: -32000, message: 'not authenticated' } })
    })
  `)
  const result = await reader({ command })(INPUT)
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected failure')
  }
  expect(result.reason).toBe('app_server_error')
  expect(result.detail).toContain('not authenticated')
})

test('initialize が error なら失敗として扱う', async () => {
  const { command } = fakeCodex(`
    import readline from 'node:readline'
    const rl = readline.createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      const msg = JSON.parse(line)
      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -1, message: 'bad client' } }) + '\\n')
    })
  `)
  const result = await reader({ command })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'app_server_error' })
})

test('応答前に終了したら失敗として扱う', async () => {
  const { command } = fakeCodex(`process.exit(1)`)
  const result = await reader({ command })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'exit_failure' })
})

test('応答しない app-server は timeout で失敗させる', async () => {
  const { command } = fakeCodex(`setInterval(() => {}, 1000)`)
  const result = await reader({ command, timeoutMs: 400 })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'timeout' })
})

test('stdout 上限超過は失敗として扱う', async () => {
  const { command } = fakeCodex(`
    setInterval(() => { process.stdout.write('x'.repeat(4096)) }, 5)
  `)
  const result = await reader({ command, maxStdoutBytes: 2048 })(INPUT)
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected failure')
  }
  expect(['stdout_limit_exceeded', 'buffer_limit_exceeded']).toContain(result.reason)
})

test('存在しない CLI は失敗として扱う', async () => {
  const result = await reader({ command: '/nonexistent/codex' })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'spawn_failed' })
})

test('rate limit を含まない応答は失敗として扱う', async () => {
  const { command } = fakeCodex(`
    import readline from 'node:readline'
    const rl = readline.createInterface({ input: process.stdin })
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
    rl.on('line', (line) => {
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') {
        send({ id: msg.id, result: {} })
        return
      }
      if (msg.method === 'account/rateLimits/read') {
        send({ id: msg.id, result: { rateLimits: null, rateLimitsByLimitId: {} } })
      }
    })
  `)
  const result = await reader({ command })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'no_rate_limits' })
})

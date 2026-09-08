import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'vite-plus/test'
import { CLAUDE_USAGE_ARGS, createClaudeReader } from './claude.js'
import { createFakeBinary } from './test-binary.js'

const INPUT = { sourceId: 'dev-machine', observedAt: '2026-09-01T11:36:47.683Z' }

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function fakeClaude(source: string): { command: string; dir: string } {
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
  return createClaudeReader({ command, timeoutMs, maxStdoutBytes })
}

test('実測形式の CLI 出力から Observation を作る', async () => {
  const { command } = fakeClaude(`
    const envelope = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'ignored',
      result: 'Current session: 11% used \\u00b7 resets Sep 1, 9:19pm (Asia/Tokyo)\\nCurrent week (all models): 13% used \\u00b7 resets Sep 6, 8:59pm (Asia/Tokyo)'
    }
    process.stdout.write(JSON.stringify(envelope))
  `)
  const result = await reader({ command })(INPUT)
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error('expected success')
  }
  expect(result.observation.provider).toBe('claude')
  expect(result.observation.buckets.length).toBe(2)
  expect(result.observation.buckets[0]).toMatchObject({
    bucketId: 'claude:session',
    usedPercent: 11,
    resetsAt: '2026-09-01T12:19:00.000Z'
  })
})

test('CLI は非対話の /usage 引数で呼ばれる', async () => {
  const { command, dir } = fakeClaude(`
    import fs from 'node:fs'
    import path from 'node:path'
    fs.writeFileSync(path.join(import.meta.dirname, 'args.json'), JSON.stringify(process.argv.slice(2)))
    process.stdout.write(JSON.stringify({ result: 'Current session: 1% used' }))
  `)
  const result = await reader({ command })(INPUT)
  expect(result.ok).toBe(true)
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'))).toEqual(
    CLAUDE_USAGE_ARGS
  )
})

test('非 0 終了は失敗として扱い fixture へ落ちない', async () => {
  const { command } = fakeClaude(`
    process.stderr.write('not logged in')
    process.exit(1)
  `)
  const result = await reader({ command })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'exit_failure' })
})

test('timeout は失敗として扱う', async () => {
  const { command } = fakeClaude(`setInterval(() => {}, 1000)`)
  const result = await reader({ command, timeoutMs: 300 })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'timeout' })
})

test('stdout 上限超過は失敗として扱う', async () => {
  const { command } = fakeClaude(`process.stdout.write('x'.repeat(200000))`)
  const result = await reader({ command, maxStdoutBytes: 1024 })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'stdout_limit_exceeded' })
})

test('存在しない CLI は失敗として扱う', async () => {
  const result = await reader({ command: '/nonexistent/claude' })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'spawn_failed' })
})

test('JSON でない出力は失敗として扱う', async () => {
  const { command } = fakeClaude(`process.stdout.write('Usage: claude [options]')`)
  const result = await reader({ command })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'invalid_json' })
})

test('rate limit 行が無い出力は失敗として扱う(fake 値を送らない)', async () => {
  const { command } = fakeClaude(`
    process.stdout.write(JSON.stringify({ result: 'You are using an API key\\nLast 24h - 3 requests' }))
  `)
  const result = await reader({ command })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'no_rate_limits' })
})

test('is_error の CLI 応答は失敗として扱う', async () => {
  const { command } = fakeClaude(`
    process.stdout.write(JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: 'x' }))
  `)
  const result = await reader({ command })(INPUT)
  expect(result).toMatchObject({ ok: false, reason: 'cli_error' })
})

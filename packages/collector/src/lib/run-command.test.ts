import { expect, test } from 'vite-plus/test'
import { runCommand } from './run-command.js'

const NODE = process.execPath

test('stdout を返して成功する', async () => {
  const result = await runCommand({
    command: NODE,
    args: ['-e', 'process.stdout.write("hello")'],
    timeoutMs: 10_000,
    maxStdoutBytes: 1024
  })
  expect(result).toEqual({ ok: true, stdout: 'hello' })
})

test('非 0 終了はエラーとして扱い stdout を返さない', async () => {
  const result = await runCommand({
    command: NODE,
    args: ['-e', 'process.stdout.write("partial"); process.exit(3)'],
    timeoutMs: 10_000,
    maxStdoutBytes: 1024
  })
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected failure')
  }
  expect(result.reason).toBe('exit_failure')
  expect(result.detail).toContain('code=3')
  expect(result.detail).not.toContain('partial')
})

test('signal 終了もエラーとして扱う', async () => {
  const result = await runCommand({
    command: NODE,
    args: ['-e', 'process.kill(process.pid, "SIGKILL")'],
    timeoutMs: 10_000,
    maxStdoutBytes: 1024
  })
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected failure')
  }
  expect(result.reason).toBe('exit_failure')
  expect(result.detail).toContain('SIGKILL')
})

test('timeout を超えたら timeout エラーになり子プロセスを終了させる', async () => {
  const started = Date.now()
  const result = await runCommand({
    command: NODE,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 300,
    maxStdoutBytes: 1024
  })
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected failure')
  }
  expect(result.reason).toBe('timeout')
  expect(result.detail).toContain('300ms')
  // 無限に待たず timeout で確実に戻る
  expect(Date.now() - started).toBeLessThan(10_000)
})

test('stdout 上限を超えたらエラーにして部分結果を返さない', async () => {
  const result = await runCommand({
    command: NODE,
    args: ['-e', 'process.stdout.write("x".repeat(4096))'],
    timeoutMs: 10_000,
    maxStdoutBytes: 64
  })
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected failure')
  }
  expect(result.reason).toBe('stdout_limit_exceeded')
  expect(result.detail).toContain('64 bytes')
})

test('存在しない command は spawn_failed になる', async () => {
  const result = await runCommand({
    command: '/nonexistent/limit-monitor-test-binary',
    args: [],
    timeoutMs: 10_000,
    maxStdoutBytes: 1024
  })
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected failure')
  }
  expect(result.reason).toBe('spawn_failed')
})

test('stderr の内容は detail に含めない', async () => {
  const result = await runCommand({
    command: NODE,
    args: ['-e', 'process.stderr.write("SECRET-TOKEN-VALUE"); process.exit(1)'],
    timeoutMs: 10_000,
    maxStdoutBytes: 1024
  })
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected failure')
  }
  expect(result.detail).not.toContain('SECRET-TOKEN-VALUE')
  expect(result.detail).toContain('stderrBytes=18')
})

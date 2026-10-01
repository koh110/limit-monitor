import fs from 'node:fs'
import { expect, test } from 'vite-plus/test'

test('worker は動的 User-Agent 解決用の CLAUDE_BIN を Claude reader へ渡す', () => {
  const source = fs.readFileSync(new URL('./worker.ts', import.meta.url), 'utf8')

  expect(source).toContain('command: CLAUDE_BIN')
})

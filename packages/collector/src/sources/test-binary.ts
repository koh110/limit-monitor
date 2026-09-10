import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * test 用に「vendor CLI のふり」をする実行可能ファイルを作る。
 * spawn / timeout / 非 0 終了などの実経路をそのまま検証するために使う。
 */
export function createFakeBinary(source: string): {
  command: string
  dir: string
  cleanup: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-fake-'))
  const scriptPath = path.join(dir, 'fake.mjs')
  const commandPath = path.join(dir, 'fake-cli')
  fs.writeFileSync(scriptPath, source, 'utf8')
  // 引数を無視して固定の node script を実行する薄い wrapper
  fs.writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, {
    encoding: 'utf8',
    mode: 0o700
  })
  return {
    command: commandPath,
    dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

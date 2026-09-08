import { spawn } from 'node:child_process'

/**
 * 子プロセス実行の失敗理由。vendor CLI の stdout/stderr の内容は
 * secret や利用状況の全文を含み得るため、失敗理由には一切含めない
 * (含めるのは exit code / signal / byte 数などの metadata のみ)。
 */
export type RunCommandFailureReason =
  | 'spawn_failed'
  | 'timeout'
  | 'stdout_limit_exceeded'
  | 'exit_failure'

export type RunCommandResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: RunCommandFailureReason; detail: string }

// SIGTERM 後に子プロセスが終了するのを待つ猶予。超えたら SIGKILL する
const KILL_GRACE_MS = 2000

export type RunCommandOptions = {
  command: string
  args: readonly string[]
  timeoutMs: number
  maxStdoutBytes: number
  cwd?: string
}

/**
 * vendor CLI を非対話で 1 回実行し stdout を返す。
 *
 * - timeout は有限。超過時は SIGTERM → SIGKILL で確実に回収する
 * - stdout は maxStdoutBytes で打ち切り、超過は失敗として扱う(部分結果を返さない)
 * - 非 0 終了・signal 終了・spawn 失敗はすべて失敗として扱う
 * - stderr は byte 数だけ数え、内容は保持しない
 */
export function runCommand({
  command,
  args,
  timeoutMs,
  maxStdoutBytes,
  cwd
}: RunCommandOptions): Promise<RunCommandResult> {
  return new Promise<RunCommandResult>((resolve) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 対話 CLI が TTY を期待して待ち続けないよう stdin は与えない
      windowsHide: true
    })

    const chunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    const timeoutTimer = setTimeout(() => {
      finish({
        ok: false,
        reason: 'timeout',
        detail: `command timed out after ${timeoutMs}ms`
      })
    }, timeoutMs)

    function terminate() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
      }, KILL_GRACE_MS)
      killTimer.unref()
    }

    function finish(result: RunCommandResult) {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeoutTimer)
      if (!result.ok) {
        terminate()
      }
      resolve(result)
    }

    child.on('error', (error: Error) => {
      finish({
        ok: false,
        reason: 'spawn_failed',
        detail: `failed to spawn "${command}": ${error.message}`
      })
    })

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maxStdoutBytes) {
        finish({
          ok: false,
          reason: 'stdout_limit_exceeded',
          detail: `stdout exceeded ${maxStdoutBytes} bytes`
        })
        return
      }
      chunks.push(chunk)
    })

    // 内容は捨てて byte 数だけ数える(vendor の出力をログへ載せない)
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
    })

    // exit ではなく close(全 stdio が閉じたあと)で確定させる
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (killTimer) {
        clearTimeout(killTimer)
      }
      if (code === 0) {
        finish({ ok: true, stdout: Buffer.concat(chunks).toString('utf8') })
        return
      }
      finish({
        ok: false,
        reason: 'exit_failure',
        detail: `command exited with code=${code ?? 'null'} signal=${signal ?? 'null'} stderrBytes=${stderrBytes}`
      })
    })
  })
}

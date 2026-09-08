#!/usr/bin/env -S node --experimental-strip-types
/**
 * limit-monitor の正規 deploy 入口。
 *
 *   sudo -E ./deploy.ts --server              # Hub + Dashboard
 *   sudo -E ./deploy.ts --collector           # Collector
 *   sudo -E ./deploy.ts --server --collector  # 全サービス
 *
 * ここは薄い委譲層で、実処理は deploy/deploy.sh が行う。この入口の責務は:
 *   - 対象サービスの選択を明示的に受け取る(未選択 / 未知引数は fail-closed)
 *   - 正規化した repository root(realpath)から deploy/deploy.sh を実行する
 *
 * service 実行ユーザーは deploy を実行した通常ユーザーに統一する。専用の
 * Linux user は作らないし前提にもしない。実行ユーザーの指定を利用者へ求めず、
 * deploy.sh が自動解決する: `sudo -E` 経由なら SUDO_USER、非 root 実行なら
 * 現在のユーザー、root 直接で主体が不明なら fail-closed で停止する。
 *
 * 秘密値は引数で渡さない。token は /etc/limit-monitor/collector-token
 * (root:root mode 600)へ置き、systemd の LoadCredential で注入する。
 * この script は環境変数の値を出力しない(存在有無だけを検査する)。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** --services へ渡す対象。canonical な順序で保持する */
export type ServiceTarget = 'server' | 'collector'

export type ParsedArgs = {
  help: boolean
  dryRun: boolean
  /** 選択順ではなく server -> collector の canonical 順 */
  services: ServiceTarget[]
}

export type ParseResult = { ok: true; value: ParsedArgs } | { ok: false; message: string }

export const USAGE = `limit-monitor deploy

使い方:
  sudo -E ./deploy.ts --server              Hub + Dashboard を deploy する
  sudo -E ./deploy.ts --collector           Collector を deploy する
  sudo -E ./deploy.ts --server --collector  全サービスを deploy する

引数:
  --server           limit-hub.service と limit-dashboard.service を対象にする
  --collector        limit-collector.service を対象にする
  --dry-run          委譲先コマンドを表示するだけで実行しない
  -h, --help         このヘルプを表示する

--server / --collector のどちらも指定しない場合は何も実行せずに終了する
(fail-closed)。未知の引数も同様に拒否する。

service 実行ユーザーは deploy を実行した通常ユーザーに統一する。limit-monitor
専用の Linux user は作らず、実行ユーザーの指定も求めない。sudo 経由なら
SUDO_USER から自動解決し、root 直接で主体が不明なら停止する。その場合は
自分の通常アカウントから 'sudo -E ./deploy.ts ...' で実行し直すこと。

環境変数(deploy/deploy.sh へそのまま渡る。値はここでは出力しない):
  VITE_HUB_BASE_URL  必須。Dashboard の build に焼き込む Hub の base URL
  INSTALL_DIR        release 配置先(既定 /var/www/limit-monitor)
  KEEP_RELEASES      残す過去 release 数(既定 5)

より細かい option は deploy/deploy.sh --help を参照する。`

/**
 * argv(実行ファイル名を除いた配列)を解析する。副作用なし。
 * 不正な入力は例外ではなく { ok: false } で返し、呼び出し側が fail-closed する。
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  let help = false
  let dryRun = false
  let server = false
  let collector = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        help = true
        break
      case '--dry-run':
        dryRun = true
        break
      case '--server':
        if (server) {
          return { ok: false, message: '--server is specified more than once' }
        }
        server = true
        break
      case '--collector':
        if (collector) {
          return { ok: false, message: '--collector is specified more than once' }
        }
        collector = true
        break
      default:
        return { ok: false, message: `unknown argument: ${arg}` }
    }
  }

  if (help) {
    return { ok: true, value: { help: true, dryRun, services: [] } }
  }

  const services: ServiceTarget[] = []
  if (server) {
    services.push('server')
  }
  if (collector) {
    services.push('collector')
  }
  if (services.length === 0) {
    return {
      ok: false,
      message: 'no service selected: pass --server and/or --collector (nothing was deployed)'
    }
  }

  return { ok: true, value: { help: false, dryRun, services } }
}

/**
 * deploy/deploy.sh へ渡す引数列を組み立てる。秘密値は含めない。
 * service 実行ユーザーは deploy.sh が SUDO_USER / 現在のユーザーから解決するため、
 * identity に関する引数は渡さない(利用者にも指定を求めない)。
 */
export function buildDeployShArgs(parsed: ParsedArgs): string[] {
  return ['--install-systemd', '--services', parsed.services.join(',')]
}

export type RepoRoot = { ok: true; root: string; script: string } | { ok: false; message: string }

/**
 * この script が置かれている場所から正規 repository root を決める。
 * symlink 経由で呼ばれても実体の root で実行するため realpath で正規化し、
 * 期待する構成(deploy/deploy.sh が通常ファイル、package.json が存在)を
 * 満たさなければ何も実行しない(fail-closed)。
 */
export function resolveRepoRoot(entryUrl: string): RepoRoot {
  let root: string
  try {
    root = fs.realpathSync(path.dirname(fileURLToPath(entryUrl)))
  } catch (error) {
    return { ok: false, message: `cannot resolve the repository root: ${String(error)}` }
  }

  const script = path.join(root, 'deploy', 'deploy.sh')
  let scriptIsFile = false
  try {
    scriptIsFile = fs.lstatSync(script).isFile()
  } catch {
    scriptIsFile = false
  }
  if (!scriptIsFile) {
    return {
      ok: false,
      message: `deploy script is missing or is not a regular file: ${script} (run ./deploy.ts from a complete checkout)`
    }
  }
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    return { ok: false, message: `not a limit-monitor checkout: ${root}/package.json is missing` }
  }
  return { ok: true, root, script }
}

function fail(message: string): never {
  process.stderr.write(`[deploy.ts] ERROR: ${message}\n`)
  process.exit(1)
}

function main(argv: readonly string[]): void {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`[deploy.ts] ERROR: ${parsed.message}\n\n${USAGE}\n`)
    process.exit(1)
  }
  if (parsed.value.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }

  const repo = resolveRepoRoot(import.meta.url)
  if (!repo.ok) {
    fail(repo.message)
  }

  // 値は出さない(秘密値を log へ出さない方針を全 env に一律適用する)。
  // 未設定のまま進むと deploy.sh 側で die するため、ここで先に案内する。
  if ((process.env.VITE_HUB_BASE_URL ?? '') === '') {
    fail(
      'VITE_HUB_BASE_URL is required (baked into the dashboard build). Set it and re-run with sudo -E so the value is preserved'
    )
  }

  const args = buildDeployShArgs(parsed.value)
  if (parsed.value.dryRun) {
    process.stdout.write(`bash ${repo.script} ${args.join(' ')}\n`)
    return
  }

  if (process.getuid?.() !== 0) {
    fail(
      "systemd install requires root. Re-run as 'sudo -E ./deploy.ts " +
        `${argv.join(' ')}' so SUDO_USER and VITE_HUB_BASE_URL are preserved`
    )
  }

  const result = spawnSync('bash', [repo.script, ...args], {
    cwd: repo.root,
    stdio: 'inherit',
    env: process.env
  })
  if (result.error !== undefined) {
    fail(`failed to run ${repo.script}: ${result.error.message}`)
  }
  if (result.signal !== null) {
    fail(`${repo.script} was terminated by signal ${result.signal}`)
  }
  process.exit(result.status ?? 1)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && path.resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}

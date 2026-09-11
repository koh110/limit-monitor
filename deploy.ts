#!/usr/bin/env -S node --experimental-strip-types
/**
 * limit-monitor の正規 deploy 入口。
 *
 *   sudo ./deploy.ts --hub-base-url <url> --server
 *   sudo ./deploy.ts --hub-base-url <url> --collector --providers codex,claude,grok
 *   sudo ./deploy.ts --hub-base-url <url> --server --collector --providers codex,claude,grok
 *
 * deploy orchestration は TypeScript で行う。外部コマンドは shell を介さず
 * child_process.spawnSync(shell=false) で実行し、env / unit / release の操作は
 * Node.js の fs API を使う。これにより deployment logic を bash の文字列抽出に
 * 依存せず直接 unit test できる。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoDuplicateEnvKeys, envAssignments } from './deploy/env.ts'
import { performDeployment } from './deploy/runtime.ts'

/** --services へ渡す対象。canonical な順序で保持する */
export type ServiceTarget = 'server' | 'collector'
export type ProviderTarget = 'codex' | 'claude' | 'grok'

const PROVIDER_TARGETS = ['codex', 'claude', 'grok'] as const satisfies readonly ProviderTarget[]

export type ParsedArgs = {
  help: boolean
  dryRun: boolean
  force: boolean
  /** 選択順ではなく server -> collector の canonical 順 */
  services: ServiceTarget[]
  /** 指定時は collector.env へ永続化する provider 一覧 */
  providers: ProviderTarget[] | undefined
  hubBaseUrl: string | undefined
}

export type ParseResult = { ok: true; value: ParsedArgs } | { ok: false; message: string }

export const USAGE = `limit-monitor deploy

使い方:
  sudo ./deploy.ts --server --hub-base-url <url>                                      Hub + Dashboard を deploy する
  sudo ./deploy.ts --collector --providers codex,claude,grok --hub-base-url <url>     Collector を deploy する
  sudo ./deploy.ts --server --collector --providers codex,claude,grok --hub-base-url <url>
                                                                                       全サービスを deploy する

引数:
  --server           limit-monitor-hub.service と limit-monitor-dashboard.service を対象にする
  --collector        limit-monitor-collector.service を対象にする
  --providers        Collector の provider (comma区切り: codex,claude,grok)。
                     指定値は全 read-only validation 成功後に
                     /etc/limit-monitor/collector.env へ atomic に永続化する。
                     省略時は既存 collector.env を変更せず、その設定を再利用する
  --hub-base-url     Dashboard に埋め込む Hub の URL(sudoの環境保持に依存しない)
  --force            同じ package.json version の既存 version directory を置き換える
  --dry-run          副作用なしで deployment plan を表示する
  -h, --help         このヘルプを表示する

--server / --collector のどちらも指定しない場合は何も実行せずに終了する
(fail-closed)。未知の引数も同様に拒否する。--providers は --collector と
組み合わせた場合だけ受理する。

service 実行ユーザーは deploy を実行した通常ユーザーに統一する。limit-monitor
専用の Linux user は作らず、実行ユーザーの指定も求めない。sudo 経由なら
SUDO_USER から自動解決し、root 直接で主体が不明なら停止する。

npm / systemctl / runuser / systemd-analyze 等の外部コマンドは shell を介さず
直接 exec する。npm build/install は root では実行せず SUDO_USER として実行する。

環境変数:
  VITE_HUB_BASE_URL  Dashboardのbuildに焼き込むHub URL(または--hub-base-url)
  INSTALL_DIR        release 配置先(既定 /var/www/limit-monitor)
  KEEP_VERSIONS      残す過去 version 数(既定 5)
`

function parseProviderList(
  raw: string
): { ok: true; providers: ProviderTarget[] } | { ok: false; message: string } {
  const parts = raw.split(',')
  const providers: ProviderTarget[] = []
  for (const part of parts) {
    const name = part.trim()
    if (name.length === 0) {
      return {
        ok: false,
        message: `--providers contains an empty entry (got: ${raw})`
      }
    }
    if (!PROVIDER_TARGETS.includes(name as ProviderTarget)) {
      return {
        ok: false,
        message: `--providers contains an unknown provider: ${name} (allowed: ${PROVIDER_TARGETS.join(',')})`
      }
    }
    const provider = name as ProviderTarget
    if (providers.includes(provider)) {
      return {
        ok: false,
        message: `--providers contains a duplicate provider: ${provider}`
      }
    }
    providers.push(provider)
  }
  if (providers.length === 0) {
    return { ok: false, message: '--providers must list at least one provider' }
  }
  return { ok: true, providers }
}

/**
 * argv(実行ファイル名を除いた配列)を解析する。副作用なし。
 * 不正な入力は例外ではなく { ok: false } で返し、呼び出し側が fail-closed する。
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  let help = false
  let dryRun = false
  let force = false
  let server = false
  let collector = false
  let providers: ProviderTarget[] | undefined
  let hubBaseUrl: string | undefined

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
      case '--force':
        if (force) return { ok: false, message: '--force is specified more than once' }
        force = true
        break
      case '--server':
        if (server) return { ok: false, message: '--server is specified more than once' }
        server = true
        break
      case '--collector':
        if (collector) return { ok: false, message: '--collector is specified more than once' }
        collector = true
        break
      case '--providers': {
        if (providers !== undefined) {
          return { ok: false, message: '--providers is specified more than once' }
        }
        const value = argv[i + 1]
        if (value === undefined) {
          return { ok: false, message: '--providers requires a comma-separated provider list' }
        }
        const parsedProviders = parseProviderList(value)
        if (!parsedProviders.ok) return parsedProviders
        providers = parsedProviders.providers
        i += 1
        break
      }
      case '--hub-base-url': {
        const value = argv[i + 1]
        if (value === undefined || !/^https?:\/\//.test(value)) {
          return {
            ok: false,
            message: `--hub-base-url requires an http(s) URL (got: ${value ?? '<missing>'})`
          }
        }
        if (hubBaseUrl !== undefined) {
          return { ok: false, message: '--hub-base-url is specified more than once' }
        }
        hubBaseUrl = value
        i += 1
        break
      }
      default:
        return { ok: false, message: `unknown argument: ${arg}` }
    }
  }

  if (help) {
    return { ok: true, value: { help: true, dryRun, force, services: [], providers, hubBaseUrl } }
  }

  const services: ServiceTarget[] = []
  if (server) services.push('server')
  if (collector) services.push('collector')
  if (services.length === 0) {
    return {
      ok: false,
      message: 'no service selected: pass --server and/or --collector (nothing was deployed)'
    }
  }
  if (providers !== undefined && !collector) {
    return {
      ok: false,
      message: '--providers requires --collector (provider selection only applies to the collector)'
    }
  }

  return { ok: true, value: { help: false, dryRun, force, services, providers, hubBaseUrl } }
}

export type RepoRoot = { ok: true; root: string } | { ok: false; message: string }

export function resolveRepoRoot(entryUrl: string): RepoRoot {
  let root: string
  try {
    root = fs.realpathSync(path.dirname(fileURLToPath(entryUrl)))
  } catch (error) {
    return { ok: false, message: `cannot resolve the repository root: ${String(error)}` }
  }
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    return { ok: false, message: `not a limit-monitor checkout: ${root}/package.json is missing` }
  }
  if (!fs.existsSync(path.join(root, 'deploy', 'systemd'))) {
    return { ok: false, message: `not a complete limit-monitor checkout: ${root}/deploy/systemd is missing` }
  }
  return { ok: true, root }
}

function loadDeployEnvDefaults(repoRoot: string): void {
  const file = path.join(repoRoot, 'deploy', 'deploy.env')
  if (!fs.existsSync(file)) return
  const content = fs.readFileSync(file, 'utf8')
  assertNoDuplicateEnvKeys(content, file)
  for (const assignment of envAssignments(content)) {
    if (process.env[assignment.key] === undefined) process.env[assignment.key] = assignment.value
  }
}

function fail(message: string): never {
  process.stderr.write(`[deploy.ts] ERROR: ${message}\n`)
  process.exit(1)
}

export function dryRunSummary(parsed: ParsedArgs, installDir: string): string {
  return [
    'deploy.ts plan',
    `services=${parsed.services.join(',')}`,
    `providers=${parsed.providers?.join(',') ?? '<persisted collector.env>'}`,
    `installDir=${installDir}`,
    `force=${parsed.force ? 'yes' : 'no'}`
  ].join(' ')
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
  if (!repo.ok) fail(repo.message)
  loadDeployEnvDefaults(repo.root)

  if (parsed.value.hubBaseUrl !== undefined) {
    process.env.VITE_HUB_BASE_URL = parsed.value.hubBaseUrl
  }
  const hubBaseUrl = process.env.VITE_HUB_BASE_URL ?? ''
  if (hubBaseUrl === '') {
    fail('VITE_HUB_BASE_URL is required (baked into the dashboard build). Pass --hub-base-url <url>')
  }

  if (parsed.value.dryRun) {
    process.stdout.write(`${dryRunSummary(parsed.value, process.env.INSTALL_DIR ?? '/var/www/limit-monitor')}\n`)
    return
  }

  try {
    performDeployment({
      repoRoot: repo.root,
      services: parsed.value.services,
      providers: parsed.value.providers,
      hubBaseUrl,
      force: parsed.value.force
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

const entryPath = process.argv[1]
if (entryPath !== undefined && path.resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}

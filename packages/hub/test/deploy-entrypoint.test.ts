import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'

// packages/hub/test -> repository root
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const DEPLOY_TS = path.join(REPO_ROOT, 'deploy.ts')
const DEPLOY_SH_PATH = path.join(REPO_ROOT, 'deploy/deploy.sh')

/**
 * 正規入口 ./deploy.ts を実際に起動する。--dry-run は委譲コマンドを表示するだけで
 * systemd も npm も触らないため、CI / 開発機で安全に実挙動を検証できる。
 */
function runDeployTs(
  args: readonly string[],
  env: Record<string, string> = {}
): { code: number; out: string; err: string } {
  const res = spawnSync(process.execPath, ['--experimental-strip-types', DEPLOY_TS, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }
  })
  return { code: res.status ?? 1, out: res.stdout ?? '', err: res.stderr ?? '' }
}

const HUB_URL_ENV = { VITE_HUB_BASE_URL: 'http://192.168.1.10:8787' }

test('deploy.ts: --server は server だけを deploy.sh へ委譲する', () => {
  const res = runDeployTs(['--server', '--dry-run'], HUB_URL_ENV)
  expect(res.code, res.err).toBe(0)
  expect(res.out.trim()).toBe(`bash ${DEPLOY_SH_PATH} --install-systemd --services server`)
})

test('deploy.ts: --collector は collector だけを deploy.sh へ委譲する', () => {
  const res = runDeployTs(['--collector', '--dry-run'], HUB_URL_ENV)
  expect(res.code, res.err).toBe(0)
  expect(res.out.trim()).toBe(`bash ${DEPLOY_SH_PATH} --install-systemd --services collector`)
})

test('deploy.ts: --hub-base-url はsudoの環境保持に依存せず委譲する', () => {
  const res = runDeployTs(['--server', '--hub-base-url', 'http://127.0.0.1:8787', '--dry-run'])
  expect(res.code, res.err).toBe(0)
  expect(res.out.trim()).toBe(
    `bash ${DEPLOY_SH_PATH} --install-systemd --services server --hub-base-url http://127.0.0.1:8787`
  )
})

test('deploy.ts: --force は同じ version の再配置指定として委譲する', () => {
  const res = runDeployTs([
    '--server',
    '--force',
    '--hub-base-url',
    'http://127.0.0.1:8787',
    '--dry-run'
  ])
  expect(res.code, res.err).toBe(0)
  expect(res.out.trim()).toBe(
    `bash ${DEPLOY_SH_PATH} --install-systemd --services server --force --hub-base-url http://127.0.0.1:8787`
  )
})

test('deploy.ts: --force の重複指定は拒否する', () => {
  const res = runDeployTs(['--server', '--force', '--force', '--dry-run'], HUB_URL_ENV)
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('--force is specified more than once')
})

test('deploy.ts: --server --collector は選択順によらず canonical 順で渡す', () => {
  const forward = runDeployTs(['--server', '--collector', '--dry-run'], HUB_URL_ENV)
  const reversed = runDeployTs(['--collector', '--server', '--dry-run'], HUB_URL_ENV)
  expect(forward.code, forward.err).toBe(0)
  expect(reversed.code, reversed.err).toBe(0)
  expect(forward.out.trim()).toBe(
    `bash ${DEPLOY_SH_PATH} --install-systemd --services server,collector`
  )
  expect(reversed.out.trim()).toBe(forward.out.trim())
})

test('deploy.ts: 委譲コマンドに install identity の引数を一切足さない', () => {
  // service 実行ユーザーは deploy.sh が SUDO_USER / 現在のユーザーから解決する。
  // 入口は user / group を受け取らず、deploy.sh へも渡さない
  const res = runDeployTs(['--server', '--collector', '--dry-run'], HUB_URL_ENV)
  expect(res.code, res.err).toBe(0)
  expect(res.out.trim()).toBe(
    `bash ${DEPLOY_SH_PATH} --install-systemd --services server,collector`
  )
  expect(res.out).not.toContain('--user')
  expect(res.out).not.toContain('--group')
})

test('deploy.ts: service 未選択は何も実行せず fail-closed', () => {
  const res = runDeployTs(['--dry-run'], HUB_URL_ENV)
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('no service selected')
  expect(res.err).toContain('nothing was deployed')
  expect(res.out).toBe('')
})

test('deploy.ts: 引数なしも fail-closed(既定で全 service を deploy しない)', () => {
  const res = runDeployTs([], HUB_URL_ENV)
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('no service selected')
  expect(res.out).toBe('')
})

test('deploy.ts: 未知の引数は fail-closed', () => {
  for (const arg of ['--everything', '-x', 'server', '--services=server']) {
    const res = runDeployTs([arg, '--server', '--dry-run'], HUB_URL_ENV)
    expect(res.code, `should reject ${arg}`).not.toBe(0)
    expect(res.err).toContain(`unknown argument: ${arg}`)
    expect(res.out).toBe('')
  }
})

test('deploy.ts: 廃止した --user / --group は未知引数として fail-closed', () => {
  // service 実行ユーザーの指定は受け付けない(黙って無視せず拒否する)
  for (const args of [
    ['--server', '--user', 'test-install-user'],
    ['--server', '--group', 'test-install-group'],
    ['--collector', '--user'],
    ['--collector', '--group']
  ]) {
    const res = runDeployTs([...args, '--dry-run'], HUB_URL_ENV)
    expect(res.code, `should reject ${args.join(' ')}`).not.toBe(0)
    expect(res.err).toContain('unknown argument: ')
    expect(res.out).toBe('')
  }
})

test('deploy.ts: 同じ option の重複指定は fail-closed', () => {
  const dupService = runDeployTs(['--server', '--server', '--dry-run'], HUB_URL_ENV)
  expect(dupService.code).not.toBe(0)
  expect(dupService.err).toContain('--server is specified more than once')
  const dupCollector = runDeployTs(['--collector', '--collector', '--dry-run'], HUB_URL_ENV)
  expect(dupCollector.code).not.toBe(0)
  expect(dupCollector.err).toContain('--collector is specified more than once')
})

test('deploy.ts: --help は service 未選択でも usage を出して成功する', () => {
  for (const flag of ['-h', '--help']) {
    const res = runDeployTs([flag])
    expect(res.code, res.err).toBe(0)
    expect(res.out).toContain('limit-monitor deploy')
    expect(res.out).toContain('--server')
    expect(res.out).toContain('--collector')
    expect(res.out).toContain('--force')
    expect(res.out).toContain('--dry-run')
  }
})

test('deploy.ts: usage は user/group の指定を利用者へ求めない', () => {
  const res = runDeployTs(['--help'])
  expect(res.code, res.err).toBe(0)
  // 固定 Linux user を作る前提を書かない
  expect(res.out).not.toContain('useradd')
  expect(res.out).not.toContain('runuser')
  // 廃止した identity option を help に載せない
  expect(res.out).not.toContain('--user')
  expect(res.out).not.toContain('--group')
  // 「install を実行した通常ユーザー」を service 実行ユーザーにすると明記する
  expect(res.out).toContain('SUDO_USER')
})

test('deploy.ts: VITE_HUB_BASE_URL 未設定は dry-run より前に fail-closed', () => {
  const res = runDeployTs(['--server', '--dry-run'])
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('VITE_HUB_BASE_URL is required')
  expect(res.out).toBe('')
})

test('deploy.ts: 秘密値を argv にも log にも出さない', () => {
  const secret = 'super-secret-token-value'
  const res = runDeployTs(['--server', '--collector', '--dry-run'], {
    ...HUB_URL_ENV,
    HUB_TOKEN: secret,
    COLLECTOR_TOKEN: secret
  })
  expect(res.code, res.err).toBe(0)
  expect(res.out).not.toContain(secret)
  expect(res.err).not.toContain(secret)
  // 委譲コマンドに token 系の引数を一切足さない
  expect(res.out).not.toContain('--token')
  expect(res.out).not.toContain('HUB_TOKEN')
})

test('deploy.ts: 非 root では systemd install を実行せず案内して停止する', () => {
  if (process.getuid?.() === 0) {
    // root で走る CI ではこの経路を踏めないため skip する(dry-run 側で検証済み)
    return
  }
  const res = runDeployTs(['--server'], HUB_URL_ENV)
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('systemd install requires root')
  expect(res.err).toContain('sudo ./deploy.ts --hub-base-url <url>')
})

// ---- deploy.sh: install identity / services 選択の実挙動 ----

function extractBashFn(fn: string): string {
  const lines = fs.readFileSync(DEPLOY_SH_PATH, 'utf8').split('\n')
  const fnIdx = lines.findIndex((line) => line.startsWith(`${fn}() {`))
  if (fnIdx < 0) throw new Error(`bash function not found: ${fn}`)
  const out: string[] = []
  let depth = 0
  for (let i = fnIdx; i < lines.length; i++) {
    const line = lines[i] ?? ''
    out.push(line)
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (depth === 0) break
  }
  return out.join('\n')
}

function runBashHarness(body: readonly string[]): { code: number; out: string; err: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-identity-'))
  try {
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, ['set -euo pipefail', ...body].join('\n'))
    const res = spawnSync('bash', [scriptPath], { encoding: 'utf8' })
    return { code: res.status ?? 1, out: res.stdout ?? '', err: res.stderr ?? '' }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * resolve_install_identity を実挙動で回す。実在アカウントを前提にしないため、
 * getent / id を stub して passwd/group entry を注入する。
 *
 * 実装は user / group の明示指定を受け付けず(option も環境変数も無い)、
 * SUDO_USER -> 現在のユーザー -> fail-closed の順にだけ解決する。group は
 * passwd entry の gid を getent group で引いた primary group に固定される。
 *
 * ユーザー名 / group 名は「テストデータであること」が読んで分かる値にし、
 * 実運用の固定アカウントと誤解されないようにする。
 */
function runResolveIdentity(opts: {
  sudoUser?: string
  euid: number
  currentUser?: string
  /** getent passwd の応答表: 名前 -> passwd 行 */
  passwd?: Record<string, string>
  /** getent group の応答表: group 名 -> gid(名前でも gid でも引ける) */
  groups?: Record<string, number>
}): { code: number; out: string; err: string } {
  const passwd = opts.passwd ?? {}
  const groups = opts.groups ?? {}
  const q = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  return runBashHarness([
    'log(){ echo "log: $*"; }',
    'die(){ echo "die: $*" >&2; exit 1; }',
    extractBashFn('is_valid_unix_name'),
    // getent passwd <name> / getent group <name|gid> の stub
    'getent() {',
    '  case "$1" in',
    '    passwd)',
    ...Object.entries(passwd).map(([name, line]) => {
      return `      if [[ "$2" == ${q(name)} ]]; then printf '%s\\n' ${q(line)}; return 0; fi`
    }),
    '      return 2 ;;',
    '    group)',
    ...Object.entries(groups).map(([name, gid]) => {
      return (
        `      if [[ "$2" == ${q(name)} || "$2" == ${q(String(gid))} ]]; then ` +
        `printf '%s\\n' ${q(`${name}:x:${gid}:`)}; return 0; fi`
      )
    }),
    '      return 2 ;;',
    '  esac',
    '  return 2',
    '}',
    `id() { printf '%s\\n' ${q(opts.currentUser ?? 'nobody')}; }`,
    extractBashFn('resolve_install_identity'),
    // bash の EUID は readonly のため、実装が切り出している current_euid を stub して
    // root / 非 root の分岐を再現する
    `current_euid() { printf '%s' ${opts.euid}; }`,
    'INSTALL_USER=""',
    'INSTALL_GROUP=""',
    opts.sudoUser === undefined ? 'unset SUDO_USER || true' : `SUDO_USER=${q(opts.sudoUser)}`,
    'resolve_install_identity',
    'echo "IDENTITY=${INSTALL_USER}:${INSTALL_GROUP}"'
  ])
}

/** 実在する home を持つ passwd 行を組み立てる(home 存在チェックを通すため) */
function passwdLine(user: string, uid: number, gid: number, home: string = os.tmpdir()): string {
  return `${user}:x:${uid}:${gid}::${home}:/bin/bash`
}

test('identity: sudo 経由なら SUDO_USER と その primary group を採用する', () => {
  const res = runResolveIdentity({
    sudoUser: 'testdata-sudo-user',
    euid: 0,
    passwd: { 'testdata-sudo-user': passwdLine('testdata-sudo-user', 4101, 4201) },
    groups: { 'testdata-sudo-group': 4201 }
  })
  expect(res.code, res.err).toBe(0)
  expect(res.out).toContain('IDENTITY=testdata-sudo-user:testdata-sudo-group')
  expect(res.out).toContain('SUDO_USER (invoked through sudo)')
})

test('identity: group は passwd の gid から引いた primary group に固定される', () => {
  // 「別 group を選ばせる入口」は存在しない。別 group が getent に居ても
  // 採用されるのは passwd entry の gid に対応する group だけ
  const res = runResolveIdentity({
    sudoUser: 'testdata-sudo-user',
    euid: 0,
    passwd: { 'testdata-sudo-user': passwdLine('testdata-sudo-user', 4101, 4201) },
    groups: { 'testdata-sudo-group': 4201, 'testdata-other-group': 4202 }
  })
  expect(res.code, res.err).toBe(0)
  expect(res.out).toContain('IDENTITY=testdata-sudo-user:testdata-sudo-group')
  expect(res.out).not.toContain('testdata-other-group')
})

test('identity: 非 root 実行では現在のユーザーを採用する', () => {
  const res = runResolveIdentity({
    euid: 1000,
    currentUser: 'testdata-current-user',
    passwd: { 'testdata-current-user': passwdLine('testdata-current-user', 4102, 4202) },
    groups: { 'testdata-current-group': 4202 }
  })
  expect(res.code, res.err).toBe(0)
  expect(res.out).toContain('IDENTITY=testdata-current-user:testdata-current-group')
  expect(res.out).toContain('current user')
})

test('identity: root 直接(SUDO_USER 無し)は fail-closed', () => {
  const res = runResolveIdentity({ euid: 0 })
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('cannot determine the install user')
  // 廃止した option を案内しない(利用者に user 指定を求めない)
  expect(res.err).not.toContain('--user')
  expect(res.err).toContain('sudo ./deploy.ts --hub-base-url <url>')
  expect(res.out).not.toContain('IDENTITY=')
})

test('identity: SUDO_USER=root は主体不明として fail-closed', () => {
  const res = runResolveIdentity({ sudoUser: 'root', euid: 0 })
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('cannot determine the install user')
})

test('identity: uid 0 のアカウントは service 実行ユーザーとして受理しない', () => {
  const res = runResolveIdentity({
    euid: 0,
    sudoUser: 'testdata-uid0-user',
    passwd: { 'testdata-uid0-user': passwdLine('testdata-uid0-user', 0, 0) },
    groups: { 'testdata-uid0-group': 0 }
  })
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('refusing to run limit-monitor services as uid 0')
  expect(res.err).not.toContain('--user')
})

test('identity: 存在しない user は fail-closed', () => {
  const res = runResolveIdentity({ euid: 0, sudoUser: 'testdata-missing-user' })
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('install user not found: testdata-missing-user')
})

test('identity: primary group の group entry が無ければ fail-closed', () => {
  const res = runResolveIdentity({
    euid: 0,
    sudoUser: 'testdata-sudo-user',
    passwd: { 'testdata-sudo-user': passwdLine('testdata-sudo-user', 4101, 4999) },
    groups: { 'testdata-sudo-group': 4201 }
  })
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('cannot resolve the primary group (gid 4999)')
  expect(res.out).not.toContain('IDENTITY=')
})

test('identity: home が存在しない user は fail-closed(vendor CLI が HOME を読む)', () => {
  const res = runResolveIdentity({
    euid: 0,
    sudoUser: 'testdata-nohome-user',
    passwd: {
      'testdata-nohome-user': passwdLine(
        'testdata-nohome-user',
        4103,
        4201,
        '/nonexistent/limit-monitor-test-home'
      )
    },
    groups: { 'testdata-sudo-group': 4201 }
  })
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('no existing absolute home directory')
})

test('identity: shell metacharacter を含む名前は unit へ渡す前に拒否する', () => {
  for (const bad of ['a b', 'a;b', '1user']) {
    const res = runResolveIdentity({ euid: 0, sudoUser: bad })
    expect(res.code, `should reject ${JSON.stringify(bad)}`).not.toBe(0)
    expect(res.err).toContain('install user name is not a valid account name')
  }
})

/** resolve_selected_services を DEPLOY_SERVICES 値に対して実行する */
function runSelectServices(services: string): { code: number; out: string; err: string } {
  return runBashHarness([
    'die(){ echo "die: $*" >&2; exit 1; }',
    extractBashFn('trim_space'),
    extractBashFn('resolve_selected_services'),
    extractBashFn('selected_unit_templates'),
    'INSTALL_SERVER=0',
    'INSTALL_COLLECTOR=0',
    `DEPLOY_SERVICES='${services.replaceAll("'", `'\\''`)}'`,
    'resolve_selected_services',
    `echo "UNITS=$(selected_unit_templates | tr '\\n' ' ')"`
  ])
}

test('services: server は hub + dashboard、collector は collector unit を選ぶ', () => {
  const server = runSelectServices('server')
  expect(server.code, server.err).toBe(0)
  expect(server.out).toContain('UNITS=limit-monitor-hub.service limit-monitor-dashboard.service ')

  const collector = runSelectServices('collector')
  expect(collector.code, collector.err).toBe(0)
  expect(collector.out).toContain('UNITS=limit-monitor-collector.service ')

  const both = runSelectServices('collector,server')
  expect(both.code, both.err).toBe(0)
  // 選択順によらず hub -> dashboard -> collector の順で反映する
  expect(both.out).toContain(
    'UNITS=limit-monitor-hub.service limit-monitor-dashboard.service limit-monitor-collector.service '
  )
})

test('services: 前後空白は trim して受理する', () => {
  const res = runSelectServices(' server , collector ')
  expect(res.code, res.err).toBe(0)
  expect(res.out).toContain(
    'UNITS=limit-monitor-hub.service limit-monitor-dashboard.service limit-monitor-collector.service '
  )
})

test('services: 空 / 空要素 / 重複 / 未知値は fail-closed', () => {
  const empty = runSelectServices('')
  expect(empty.code).not.toBe(0)
  expect(empty.err).toContain('--services must not be empty')

  const blank = runSelectServices('   ')
  expect(blank.code).not.toBe(0)
  expect(blank.err).toContain('--services must not be empty')

  for (const value of ['server,', ',server', 'server,,collector']) {
    const res = runSelectServices(value)
    expect(res.code, `should reject ${JSON.stringify(value)}`).not.toBe(0)
    expect(res.err).toContain('--services has an empty element')
  }

  const dup = runSelectServices('server,server')
  expect(dup.code).not.toBe(0)
  expect(dup.err).toContain("--services has a duplicate entry 'server'")

  for (const value of ['hub', 'dashboard', 'all', 'Server']) {
    const res = runSelectServices(value)
    expect(res.code, `should reject ${JSON.stringify(value)}`).not.toBe(0)
    expect(res.err).toContain('--services has an unknown target')
  }
})

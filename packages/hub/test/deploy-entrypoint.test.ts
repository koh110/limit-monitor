import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'
import { dryRunSummary, parseArgs } from '../../../deploy.ts'
import { type CommandRunner } from '../../../deploy/exec.ts'
import { copyEntry, prepareCollectorEnv, resolveInstallIdentity } from '../../../deploy/runtime.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const DEPLOY_TS = path.join(REPO_ROOT, 'deploy.ts')

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

test('deploy.ts: --server は TS deployment plan で server だけを選ぶ', () => {
  const res = runDeployTs(['--server', '--dry-run'], HUB_URL_ENV)
  expect(res.code, res.err).toBe(0)
  expect(res.out.trim()).toBe(
    'deploy.ts plan services=server providers=<persisted collector.env> installDir=/var/www/limit-monitor force=no'
  )
  expect(res.out).not.toContain('bash ')
})

test('deploy.ts: --collector は TS deployment plan で collector だけを選ぶ', () => {
  const res = runDeployTs(['--collector', '--dry-run'], HUB_URL_ENV)
  expect(res.code, res.err).toBe(0)
  expect(res.out.trim()).toContain('services=collector')
  expect(res.out).not.toContain('bash ')
})

test('deploy.ts: --hub-base-url は sudo の環境保持に依存しない', () => {
  const res = runDeployTs(['--server', '--hub-base-url', 'http://127.0.0.1:8787', '--dry-run'])
  expect(res.code, res.err).toBe(0)
  expect(res.out.trim()).toContain('services=server')
})

test('deploy.ts: --force は plan に反映する', () => {
  const res = runDeployTs([
    '--server',
    '--force',
    '--hub-base-url',
    'http://127.0.0.1:8787',
    '--dry-run'
  ])
  expect(res.code, res.err).toBe(0)
  expect(res.out).toContain('force=yes')
})

test('deploy.ts: --force の重複指定は拒否する', () => {
  const res = runDeployTs(['--server', '--force', '--force', '--dry-run'], HUB_URL_ENV)
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('--force is specified more than once')
})

test('deploy.ts: --server --collector は選択順によらず canonical 順', () => {
  const forward = parseArgs(['--server', '--collector'])
  const reversed = parseArgs(['--collector', '--server'])
  expect(forward.ok).toBe(true)
  expect(reversed.ok).toBe(true)
  if (!forward.ok || !reversed.ok) return
  expect(forward.value.services).toEqual(['server', 'collector'])
  expect(reversed.value.services).toEqual(forward.value.services)
})

test('dryRunSummary は install identity や秘密値を command line に展開しない', () => {
  const parsed = parseArgs(['--server', '--collector'])
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) return
  const summary = dryRunSummary(parsed.value, '/var/www/limit-monitor')
  expect(summary).not.toContain('--user')
  expect(summary).not.toContain('--group')
  expect(summary).not.toContain('HUB_TOKEN')
  expect(summary).not.toContain('COLLECTOR_TOKEN')
  expect(summary).not.toContain('bash ')
})

test('deploy.ts: service 未選択は何も実行せず fail-closed', () => {
  const res = runDeployTs(['--dry-run'], HUB_URL_ENV)
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('no service selected')
  expect(res.err).toContain('nothing was deployed')
  expect(res.out).toBe('')
})

test('deploy.ts: 引数なしも fail-closed', () => {
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

test('deploy.ts: 同じ service option の重複指定は fail-closed', () => {
  const server = parseArgs(['--server', '--server'])
  const collector = parseArgs(['--collector', '--collector'])
  expect(server).toEqual({ ok: false, message: '--server is specified more than once' })
  expect(collector).toEqual({ ok: false, message: '--collector is specified more than once' })
})

test('deploy.ts: --help は service 未選択でも成功し TS 実装を説明する', () => {
  const res = runDeployTs(['--help'])
  expect(res.code, res.err).toBe(0)
  expect(res.out).toContain('limit-monitor deploy')
  expect(res.out).toContain('--server')
  expect(res.out).toContain('--collector')
  expect(res.out).toContain('--providers')
  expect(res.out).toContain('shell を介さず')
  expect(res.out).not.toContain('useradd')
  expect(res.out).not.toContain('--user')
  expect(res.out).not.toContain('--group')
})

test('deploy.ts: VITE_HUB_BASE_URL 未設定は dry-run より前に fail-closed', () => {
  const res = runDeployTs(['--server', '--dry-run'])
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('VITE_HUB_BASE_URL is required')
  expect(res.out).toBe('')
})

test('release staging は workspace dependency の symlink を一時dir外へ持ち出さない', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-copy-test-'))
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  const packageDir = path.join(source, 'packages', 'shared')
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), '{"name":"shared"}\\n')
  fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true })
  fs.symlinkSync('../packages/shared', path.join(source, 'node_modules', 'shared'))

  copyEntry(source, target)

  const stagedDependency = path.join(target, 'node_modules', 'shared')
  expect(fs.lstatSync(stagedDependency).isSymbolicLink()).toBe(false)
  expect(fs.readFileSync(path.join(stagedDependency, 'package.json'), 'utf8')).toContain('"shared"')
  fs.rmSync(root, { recursive: true, force: true })
})

test('deploy.ts: dry-run は秘密値を出力しない', () => {
  const secret = 'super-secret-token-value'
  const res = runDeployTs(['--server', '--collector', '--dry-run'], {
    ...HUB_URL_ENV,
    HUB_TOKEN: secret,
    COLLECTOR_TOKEN: secret
  })
  expect(res.code, res.err).toBe(0)
  expect(res.out).not.toContain(secret)
  expect(res.err).not.toContain(secret)
})

test('deploy.ts: 非 root の実 deploy は systemd 操作前に停止する', () => {
  if (process.getuid?.() === 0) return
  const res = runDeployTs(['--server'], HUB_URL_ENV)
  expect(res.code).not.toBe(0)
  expect(res.err).toContain('systemd operations require root')
})

function identityRunner(opts: {
  currentUser?: string
  passwd?: Record<string, string>
  groups?: Record<string, number>
}): CommandRunner {
  const passwd = opts.passwd ?? {}
  const groups = opts.groups ?? {}
  return (command, args = []) => {
    if (command === 'id' && args.join(' ') === '-un') {
      return { status: 0, stdout: `${opts.currentUser ?? 'nobody'}\n`, stderr: '' }
    }
    if (command === 'getent' && args[0] === 'passwd') {
      const line = passwd[args[1] ?? '']
      return line === undefined
        ? { status: 2, stdout: '', stderr: '' }
        : { status: 0, stdout: `${line}\n`, stderr: '' }
    }
    if (command === 'getent' && args[0] === 'group') {
      const lookup = args[1] ?? ''
      for (const [name, gid] of Object.entries(groups)) {
        if (lookup === name || lookup === String(gid)) {
          return { status: 0, stdout: `${name}:x:${gid}:\n`, stderr: '' }
        }
      }
      return { status: 2, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
}

function passwdLine(user: string, uid: number, gid: number, home = '/tmp'): string {
  return `${user}:x:${uid}:${gid}::${home}:/bin/sh`
}

test('identity: sudo 経由なら SUDO_USER と primary group を採用する', () => {
  const identity = resolveInstallIdentity(
    identityRunner({
      passwd: { 'testdata-sudo-user': passwdLine('testdata-sudo-user', 4101, 4201) },
      groups: { 'testdata-sudo-group': 4201 }
    }),
    { SUDO_USER: 'testdata-sudo-user' },
    0
  )
  expect(identity.user).toBe('testdata-sudo-user')
  expect(identity.group).toBe('testdata-sudo-group')
  expect(identity.uid).toBe(4101)
  expect(identity.gid).toBe(4201)
})

test('identity: 非 root 実行では現在のユーザーを採用する', () => {
  const identity = resolveInstallIdentity(
    identityRunner({
      currentUser: 'testdata-current-user',
      passwd: { 'testdata-current-user': passwdLine('testdata-current-user', 4102, 4202) },
      groups: { 'testdata-current-group': 4202 }
    }),
    {},
    1000
  )
  expect(identity.user).toBe('testdata-current-user')
  expect(identity.group).toBe('testdata-current-group')
})

test('identity: root 直接 / SUDO_USER=root は fail-closed', () => {
  const runner = identityRunner({})
  expect(() => resolveInstallIdentity(runner, {}, 0)).toThrow(/cannot determine the install user/)
  expect(() => resolveInstallIdentity(runner, { SUDO_USER: 'root' }, 0)).toThrow(
    /cannot determine the install user/
  )
})

test('identity: uid 0 / 不正名 / primary group 不明を fail-closed にする', () => {
  expect(() =>
    resolveInstallIdentity(
      identityRunner({
        passwd: { 'testdata-uid0': passwdLine('testdata-uid0', 0, 0) },
        groups: { root: 0 }
      }),
      { SUDO_USER: 'testdata-uid0' },
      0
    )
  ).toThrow(/uid 0/)

  expect(() => resolveInstallIdentity(identityRunner({}), { SUDO_USER: 'a b' }, 0)).toThrow(
    /not a valid account name/
  )

  expect(() =>
    resolveInstallIdentity(
      identityRunner({
        passwd: { 'testdata-user': passwdLine('testdata-user', 4101, 4999) }
      }),
      { SUDO_USER: 'testdata-user' },
      0
    )
  ).toThrow(/cannot resolve the primary group/)
})

test('canonical deploy runtime は既存 collector.env から obsolete interval だけを除去する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-collector-env-migration-'))
  try {
    const dest = path.join(dir, 'collector.env')
    fs.writeFileSync(
      dest,
      [
        'INSTALL_DIR=/var/www/limit-monitor',
        'COLLECTOR_MODE=mock',
        'COLLECTOR_INTERVAL_SECONDS=60',
        'SOURCE_ID=existing-host',
        'COLLECTOR_PROVIDERS=codex',
        ''
      ].join('\n')
    )

    const prepared = prepareCollectorEnv(
      () => {
        throw new Error('mock runner must not be called for COLLECTOR_MODE=mock')
      },
      {
        user: 'test-user',
        uid: 1000,
        group: 'test-group',
        gid: 1000,
        home: '/tmp',
        shell: '/bin/sh'
      },
      REPO_ROOT,
      dest,
      '/var/www/limit-monitor',
      undefined,
      {}
    )

    expect(prepared.existing).toBe(true)
    expect(prepared.content).not.toContain('COLLECTOR_INTERVAL_SECONDS')
    expect(prepared.content).toContain('SOURCE_ID=existing-host')
    expect(prepared.content).toContain('COLLECTOR_PROVIDERS=codex')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

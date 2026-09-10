import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const DEPLOY_TS = path.join(REPO_ROOT, 'deploy.ts')
const DEPLOY_SH = path.join(REPO_ROOT, 'deploy/deploy.sh')
const HUB_URL_ENV = { VITE_HUB_BASE_URL: 'http://127.0.0.1:8787' }

function runDeploy(args: readonly string[]) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', DEPLOY_TS, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...HUB_URL_ENV
    }
  })
  return {
    code: result.status ?? 1,
    out: result.stdout ?? '',
    err: result.stderr ?? ''
  }
}

test('deploy.ts: --providers を collector deploy へ渡す', () => {
  const result = runDeploy([
    '--collector',
    '--providers',
    'codex,claude,grok',
    '--dry-run'
  ])

  expect(result.code, result.err).toBe(0)
  expect(result.out.trim()).toBe(
    `bash ${DEPLOY_SH} --install-systemd --services collector --providers codex,claude,grok`
  )
})

test('deploy.ts: grok 単独も provider として指定できる', () => {
  const result = runDeploy(['--collector', '--providers', 'grok', '--dry-run'])

  expect(result.code, result.err).toBe(0)
  expect(result.out).toContain('--providers grok')
})

test('deploy.ts: --providers は collector を選んだ時だけ受理する', () => {
  const result = runDeploy(['--server', '--providers', 'grok', '--dry-run'])

  expect(result.code).not.toBe(0)
  expect(result.err).toContain('--providers requires --collector')
})

test('deploy.ts: provider の未知名・空要素・重複を fail-closed で拒否する', () => {
  for (const providers of ['gemini', 'codex,,grok', 'grok,grok']) {
    const result = runDeploy(['--collector', '--providers', providers, '--dry-run'])

    expect(result.code, providers).not.toBe(0)
    expect(result.out).toBe('')
  }
})

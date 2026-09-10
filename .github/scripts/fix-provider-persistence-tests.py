from pathlib import Path

Path('packages/hub/test/deploy-provider-persistence.test.ts').write_text(r'''import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const DEPLOY_SH_PATH = path.join(REPO_ROOT, 'deploy/deploy.sh')
const DEPLOY_SH = fs.readFileSync(DEPLOY_SH_PATH, 'utf8')

function extractBashFn(name: string): string {
  const lines = DEPLOY_SH.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`))
  if (start < 0) throw new Error(`bash function not found: ${name}`)
  const out: string[] = []
  let depth = 0
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    out.push(line)
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (depth === 0) break
  }
  return out.join('\n')
}

function runHarness(cwd: string, lines: readonly string[]) {
  const script = path.join(cwd, 'harness.sh')
  fs.writeFileSync(
    script,
    [
      'set -euo pipefail',
      'log(){ :; }',
      'die(){ echo "$*" >&2; exit 1; }',
      ...lines
    ].join('\n')
  )
  const result = spawnSync('bash', [script], { cwd, encoding: 'utf8' })
  return { code: result.status ?? 1, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function readEnvSupport(): string[] {
  return [
    'trim_leading_space(){ local value="$1"; value="${value#"${value%%[![:space:]]*}"}"; printf "%s" "$value"; }',
    extractBashFn('read_env_value')
  ]
}

test('deploy --providers は systemd の一時 override ではなく collector.env 永続化を使う', () => {
  expect(DEPLOY_SH).toContain('render_collector_providers_env')
  expect(DEPLOY_SH).toContain('install_collector_env_candidate')
  expect(DEPLOY_SH).not.toContain(
    'Environment=COLLECTOR_PROVIDERS=${DEPLOY_COLLECTOR_PROVIDERS}'
  )
})

test('render_collector_providers_env は provider だけを差し替え、他の既存設定を保持する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-provider-render-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'collector.env'),
      [
        'COLLECTOR_MODE=real',
        'COLLECTOR_PROVIDERS=codex,claude',
        'SOURCE_ID=existing-host',
        'CODEX_BIN=/custom/codex',
        ''
      ].join('\n')
    )
    const result = runHarness(dir, [
      ...readEnvSupport(),
      extractBashFn('render_collector_providers_env'),
      'render_collector_providers_env collector.env candidate.env grok',
      'cat candidate.env'
    ])
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('COLLECTOR_PROVIDERS=grok')
    expect(result.out).toContain('SOURCE_ID=existing-host')
    expect(result.out).toContain('CODEX_BIN=/custom/codex')
    expect(result.out).not.toContain('COLLECTOR_PROVIDERS=codex,claude')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('render_collector_providers_env は key が無い既存 env に provider を追加できる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-provider-append-'))
  try {
    fs.writeFileSync(path.join(dir, 'collector.env'), 'COLLECTOR_MODE=real\nSOURCE_ID=existing-host\n')
    const result = runHarness(dir, [
      ...readEnvSupport(),
      extractBashFn('render_collector_providers_env'),
      'render_collector_providers_env collector.env candidate.env codex,grok',
      'cat candidate.env'
    ])
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('SOURCE_ID=existing-host')
    expect(result.out).toContain('COLLECTOR_PROVIDERS=codex,grok')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('render_collector_providers_env は duplicate key を fail-closed にする', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-provider-duplicate-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'collector.env'),
      'COLLECTOR_PROVIDERS=codex\nCOLLECTOR_PROVIDERS=grok\n'
    )
    const result = runHarness(dir, [
      ...readEnvSupport(),
      extractBashFn('render_collector_providers_env'),
      'render_collector_providers_env collector.env candidate.env grok'
    ])
    expect(result.code).not.toBe(0)
    expect(result.err).toContain('duplicate COLLECTOR_PROVIDERS')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('install_collector_env_candidate は既存 env の mode を保って atomic 更新する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-provider-install-'))
  try {
    const candidate = path.join(dir, 'candidate.env')
    const dest = path.join(dir, 'collector.env')
    fs.writeFileSync(candidate, 'COLLECTOR_PROVIDERS=grok\nSOURCE_ID=kept\n')
    fs.writeFileSync(dest, 'COLLECTOR_PROVIDERS=codex,claude\nSOURCE_ID=kept\n')
    fs.chmodSync(dest, 0o640)
    const beforeMode = fs.statSync(dest).mode & 0o777
    const result = runHarness(dir, [
      extractBashFn('install_collector_env_candidate'),
      'install_collector_env_candidate candidate.env collector.env 0640'
    ])
    expect(result.code, result.err).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toBe('COLLECTOR_PROVIDERS=grok\nSOURCE_ID=kept\n')
    expect(fs.statSync(dest).mode & 0o777).toBe(beforeMode)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
''')

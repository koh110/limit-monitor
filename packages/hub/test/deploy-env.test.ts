import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'
import { envSource } from '../../../deploy/runtime.ts'
import {
  DeployConfigError,
  atomicWriteTextFile,
  duplicateEnvKeys,
  ensureSecretEnvFileMode,
  prepareRefreshTokenEnvs,
  readEnvValue,
  renderCollectorProviders,
  renderEnvUpdates,
  removeEnvKeys
} from '../../../deploy/env.ts'

test('renderCollectorProviders は provider だけを更新して他の設定とコメントを保持する', () => {
  const source = [
    '# collector settings',
    'COLLECTOR_MODE=real',
    'COLLECTOR_PROVIDERS=codex,claude',
    'SOURCE_ID=existing-host',
    'CODEX_BIN=/custom/codex',
    ''
  ].join('\n')

  const rendered = renderCollectorProviders(source, ['grok'])

  expect(rendered).toContain('# collector settings')
  expect(rendered).toContain('COLLECTOR_MODE=real')
  expect(rendered).toContain('COLLECTOR_PROVIDERS=grok')
  expect(rendered).toContain('SOURCE_ID=existing-host')
  expect(rendered).toContain('CODEX_BIN=/custom/codex')
  expect(rendered).not.toContain('COLLECTOR_PROVIDERS=codex,claude')
})

test('renderCollectorProviders は provider key が無ければ追加する', () => {
  const rendered = renderCollectorProviders('COLLECTOR_MODE=real\nSOURCE_ID=host\n', [
    'codex',
    'grok'
  ])

  expect(rendered).toContain('SOURCE_ID=host')
  expect(rendered).toContain('COLLECTOR_PROVIDERS=codex,grok')
})

test('env parser は duplicate active key を fail-closed にする', () => {
  const content = [
    '# COLLECTOR_PROVIDERS=commented-out',
    'COLLECTOR_PROVIDERS=codex',
    '  COLLECTOR_PROVIDERS=grok',
    ''
  ].join('\n')

  expect(duplicateEnvKeys(content)).toEqual(['COLLECTOR_PROVIDERS'])
  expect(() => readEnvValue(content, 'COLLECTOR_PROVIDERS')).toThrow(DeployConfigError)
  expect(() => renderCollectorProviders(content, ['grok'])).toThrow(
    /collector\.env has duplicate keys: COLLECTOR_PROVIDERS/
  )
})

test('renderEnvUpdates は INSTALL_DIR と CORS のような複数値も同じ実装で更新できる', () => {
  const rendered = renderEnvUpdates(
    'INSTALL_DIR=/var/www/limit-monitor\nCORS_ALLOWED_ORIGINS=http://localhost:5173\n',
    {
      INSTALL_DIR: '/srv/limit-monitor',
      CORS_ALLOWED_ORIGINS: 'https://monitor.example.com'
    }
  )

  expect(rendered).toBe(
    'INSTALL_DIR=/srv/limit-monitor\nCORS_ALLOWED_ORIGINS=https://monitor.example.com\n'
  )
})

test('atomicWriteTextFile は既存 mode を維持して atomic replace する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-env-'))
  try {
    const file = path.join(dir, 'collector.env')
    fs.writeFileSync(file, 'COLLECTOR_PROVIDERS=codex,claude\n')
    fs.chmodSync(file, 0o640)
    const before = fs.statSync(file)

    expect(atomicWriteTextFile(file, 'COLLECTOR_PROVIDERS=grok\n', 0o640)).toBe(true)

    const after = fs.statSync(file)
    expect(after.mode & 0o777).toBe(before.mode & 0o777)
    expect(fs.readFileSync(file, 'utf8')).toBe('COLLECTOR_PROVIDERS=grok\n')
    expect(atomicWriteTextFile(file, 'COLLECTOR_PROVIDERS=grok\n', 0o640)).toBe(false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('atomicWriteTextFile は symlink を上書きしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-env-link-'))
  try {
    const target = path.join(dir, 'target.env')
    const link = path.join(dir, 'collector.env')
    fs.writeFileSync(target, 'COLLECTOR_PROVIDERS=codex\n')
    fs.symlinkSync(target, link)

    expect(() => atomicWriteTextFile(link, 'COLLECTOR_PROVIDERS=grok\n', 0o640)).toThrow(
      /refusing to replace non-regular file/
    )
    expect(fs.readFileSync(target, 'utf8')).toBe('COLLECTOR_PROVIDERS=codex\n')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('removeEnvKeys は obsolete key だけを除去し、他の設定とコメントを保持する', () => {
  const source = [
    '# collector settings',
    'COLLECTOR_MODE=real',
    'COLLECTOR_INTERVAL_SECONDS=60',
    'SOURCE_ID=existing-host',
    'COLLECTOR_PROVIDERS=codex,claude',
    ''
  ].join('\n')

  expect(removeEnvKeys(source, ['COLLECTOR_INTERVAL_SECONDS'], 'collector.env')).toBe(
    [
      '# collector settings',
      'COLLECTOR_MODE=real',
      'SOURCE_ID=existing-host',
      'COLLECTOR_PROVIDERS=codex,claude',
      ''
    ].join('\n')
  )
})

test('prepareRefreshTokenEnvs は初回のplaceholderを同じtokenへ置換する', () => {
  const result = prepareRefreshTokenEnvs(
    [
      '# hub settings',
      'INSTALL_DIR=/var/www/limit-monitor',
      'HUB_REFRESH_TOKEN=replace-with-a-random-service-token',
      ''
    ].join('\n'),
    [
      '# dashboard settings',
      'INSTALL_DIR=/var/www/limit-monitor',
      'HUB_REFRESH_TOKEN=replace-with-a-random-service-token',
      ''
    ].join('\n'),
    () => 'generated-refresh-token'
  )

  expect(result.generated).toBe(true)
  expect(readEnvValue(result.hub, 'HUB_REFRESH_TOKEN')).toBe('generated-refresh-token')
  expect(readEnvValue(result.dashboard, 'HUB_REFRESH_TOKEN')).toBe('generated-refresh-token')
  expect(result.hub).toContain('# hub settings')
  expect(result.dashboard).toContain('# dashboard settings')
})

test('prepareRefreshTokenEnvs はtokenなしの既存envにも初回tokenを追加する', () => {
  const result = prepareRefreshTokenEnvs(
    'INSTALL_DIR=/var/www/limit-monitor\nCORS_ALLOWED_ORIGINS=http://127.0.0.1:8788\n',
    'INSTALL_DIR=/var/www/limit-monitor\nHOST=0.0.0.0\n',
    () => 'generated-refresh-token'
  )

  expect(result.generated).toBe(true)
  expect(readEnvValue(result.hub, 'HUB_REFRESH_TOKEN')).toBe('generated-refresh-token')
  expect(readEnvValue(result.dashboard, 'HUB_REFRESH_TOKEN')).toBe('generated-refresh-token')
  expect(result.hub).toContain('CORS_ALLOWED_ORIGINS=http://127.0.0.1:8788')
  expect(result.dashboard).toContain('HOST=0.0.0.0')
})

test('prepareRefreshTokenEnvs は片側の既存tokenをもう片側へ反映する', () => {
  const hub = 'INSTALL_DIR=/var/www/limit-monitor\nHUB_REFRESH_TOKEN=existing-token\n'
  const dashboard = 'INSTALL_DIR=/var/www/limit-monitor\n'
  const result = prepareRefreshTokenEnvs(hub, dashboard, () => {
    throw new Error('token generator must not be called')
  })

  expect(result.generated).toBe(false)
  expect(result.hub).toBe(hub)
  expect(readEnvValue(result.dashboard, 'HUB_REFRESH_TOKEN')).toBe('existing-token')
})

test('prepareRefreshTokenEnvs はHubとDashboardのtoken不一致を拒否する', () => {
  expect(() =>
    prepareRefreshTokenEnvs(
      'HUB_REFRESH_TOKEN=hub-token\n',
      'HUB_REFRESH_TOKEN=dashboard-token\n',
      () => 'unused-token'
    )
  ).toThrow(/HUB_REFRESH_TOKEN differs between hub and dashboard env/)
})

test('prepareRefreshTokenEnvs は既定で暗号学的random tokenを一度だけ生成する', () => {
  const result = prepareRefreshTokenEnvs(
    'HUB_REFRESH_TOKEN=replace-with-a-random-service-token\n',
    'HUB_REFRESH_TOKEN=replace-with-a-random-service-token\n'
  )
  const hubToken = readEnvValue(result.hub, 'HUB_REFRESH_TOKEN')
  const dashboardToken = readEnvValue(result.dashboard, 'HUB_REFRESH_TOKEN')

  expect(result.generated).toBe(true)
  expect(hubToken).toMatch(/^[0-9a-f]{64}$/)
  expect(dashboardToken).toBe(hubToken)
})

test('prepareRefreshTokenEnvs は生成tokenの改行を拒否する', () => {
  expect(() =>
    prepareRefreshTokenEnvs(
      'HUB_REFRESH_TOKEN=replace-with-a-random-service-token\n',
      'HUB_REFRESH_TOKEN=replace-with-a-random-service-token\n',
      () => 'invalid\nrefresh-token'
    )
  ).toThrow(/generated HUB_REFRESH_TOKEN must be a non-empty single-line value/)
})

test('ensureSecretEnvFileMode は既存envの公開read bitを除去する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-secret-env-'))
  try {
    const file = path.join(dir, 'hub.env')
    fs.writeFileSync(file, 'HUB_REFRESH_TOKEN=secret\n')
    fs.chmodSync(file, 0o644)

    ensureSecretEnvFileMode(file)

    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureSecretEnvFileMode はdangling symlinkを未作成として扱わない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-secret-env-link-'))
  try {
    const file = path.join(dir, 'hub.env')
    fs.symlinkSync(path.join(dir, 'missing.env'), file)

    expect(() => ensureSecretEnvFileMode(file)).toThrow(
      /secret env path must be a regular non-symlink file/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('envSource はdangling symlinkをexample未作成扱いしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-env-source-link-'))
  try {
    const file = path.join(dir, 'hub.env')
    fs.symlinkSync(path.join(dir, 'missing.env'), file)

    expect(() =>
      envSource(file, 'INSTALL_DIR=/var/www/limit-monitor\n', '/var/www/limit-monitor')
    ).toThrow(/env path must be a regular non-symlink file/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

function readDeployFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'deploy', relativePath), 'utf8')
}

function extractDeployBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  if (startIndex < 0 || endIndex < 0) throw new Error(`deploy block not found: ${start}`)
  return source.slice(startIndex, endIndex)
}

function runLegacyCollectorCleanup(source: string, content: string): string {
  const dir = fs.mkdtempSync(path.join('/tmp', 'limit-monitor-deploy-test-'))
  const file = path.join(dir, 'collector.env')
  fs.writeFileSync(file, content)
  try {
    const script = [
      'set -euo pipefail',
      'log() { :; }',
      extractDeployBlock(source, 'trim_leading_space() {', '\nread_env_value() {'),
      extractDeployBlock(source, 'remove_legacy_collector_interval() {', '\n# 検証対象 env'),
      'remove_legacy_collector_interval "$1"'
    ].join('\n')
    execFileSync('bash', ['-c', script, 'bash', file], { stdio: 'pipe' })
    return fs.readFileSync(file, 'utf8')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function directivesOf(content: string): string {
  return content
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
}

const HUB_UNIT = readDeployFile('systemd/limit-monitor-hub.service')
const COLLECTOR_UNIT = readDeployFile('systemd/limit-monitor-collector.service')
const DASHBOARD_UNIT = readDeployFile('systemd/limit-monitor-dashboard.service')
const HUB_ENV = readDeployFile('hub.env.example')
const COLLECTOR_ENV = readDeployFile('collector.env.example')
const DASHBOARD_ENV = readDeployFile('dashboard.env.example')

test('systemd unit は INSTALL_DIR を EnvironmentFile で差し替えできる', () => {
  for (const unit of [HUB_UNIT, COLLECTOR_UNIT, DASHBOARD_UNIT]) {
    expect(unit).toMatch(/ExecStart=\/usr\/bin\/node \$\{INSTALL_DIR\}\/current\//)
    expect(unit).toContain('Environment=INSTALL_DIR=/var/www/limit-monitor')
    expect(unit).toMatch(/EnvironmentFile=-\/etc\/limit-monitor\//)
    expect(unit.indexOf('Environment=INSTALL_DIR=')).toBeLessThan(unit.indexOf('EnvironmentFile=-'))
    expect(directivesOf(unit)).not.toContain('/opt/limit-monitor')
  }
})

test('Hub unit / env は production DB と CORS を明示する', () => {
  expect(HUB_UNIT).toContain('Environment=DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite')
  expect(HUB_UNIT).toContain('StateDirectory=limit-monitor')
  expect(HUB_UNIT).toContain('ProtectSystem=strict')
  expect(HUB_ENV).toContain('INSTALL_DIR=')
  expect(HUB_ENV).toContain('APP_ENV=production')
  expect(HUB_ENV).toMatch(/^CORS_ALLOWED_ORIGINS=https?:\/\/\S+$/m)
  expect(HUB_ENV).not.toContain('CORS_ALLOWED_ORIGINS=*')
})

test('Collector unit は real mode と systemd credential を使う', () => {
  expect(COLLECTOR_UNIT).toContain('Type=simple')
  expect(COLLECTOR_UNIT).toContain('/packages/collector/dist/src/agent.js')
  expect(COLLECTOR_UNIT).not.toContain('Type=oneshot')
  expect(COLLECTOR_ENV).not.toContain('COLLECTOR_INTERVAL_SECONDS')
  expect(COLLECTOR_UNIT).toContain('Environment=COLLECTOR_MODE=real')
  expect(COLLECTOR_ENV).toContain('COLLECTOR_MODE=real')
  expect(directivesOf(COLLECTOR_UNIT)).not.toContain('COLLECTOR_MODE=mock')
  expect(COLLECTOR_UNIT).toContain('LoadCredential=hub-token:/etc/limit-monitor/collector-token')
  expect(COLLECTOR_UNIT).toContain('Environment=HUB_TOKEN_FILE=%d/hub-token')
  expect(directivesOf(COLLECTOR_UNIT)).not.toMatch(/Environment=HUB_TOKEN=\S/)
  expect(COLLECTOR_ENV).not.toMatch(/^HUB_TOKEN=\S/m)
})

test('Collector provider selection は collector.env だけを source of truth にする', () => {
  expect(COLLECTOR_ENV).toMatch(/^COLLECTOR_PROVIDERS=codex,claude$/m)
  expect(directivesOf(COLLECTOR_UNIT)).not.toMatch(/^Environment=COLLECTOR_PROVIDERS=/m)
  expect(COLLECTOR_UNIT).toContain('EnvironmentFile=-/etc/limit-monitor/collector.env')
})

test('Hub env が periodic collector trigger の間隔を管理する', () => {
  expect(HUB_ENV).toMatch(/^COLLECTOR_TRIGGER_INTERVAL_SECONDS=\d+$/m)
  expect(HUB_ENV).not.toContain('COLLECTOR_INTERVAL_SECONDS')
})

test('Collector unit は vendor CLI が HOME の login 情報を読める', () => {
  expect(COLLECTOR_UNIT).toContain('ProtectHome=false')
  expect(directivesOf(COLLECTOR_UNIT)).not.toContain('ProtectHome=true')
  expect(COLLECTOR_ENV).toContain('CODEX_BIN=')
  expect(COLLECTOR_ENV).toContain('CLAUDE_BIN=')
  expect(COLLECTOR_ENV).toContain('GROK_BIN=')
})

test('Collector env example は source id を持ち account alias を強制しない', () => {
  expect(COLLECTOR_ENV).toContain('SOURCE_ID=')
  expect(COLLECTOR_ENV).not.toMatch(/^ACCOUNT_ALIAS=/m)
})

test('Dashboard unit / env は静的 server の listen 設定を持つ', () => {
  expect(DASHBOARD_UNIT).toContain('EnvironmentFile=-/etc/limit-monitor/dashboard.env')
  expect(DASHBOARD_ENV).toMatch(/^HOST=127\.0\.0\.1$/m)
  expect(DASHBOARD_ENV).toMatch(/^PORT=8788$/m)
})

test('systemd unit template は deploy.ts が埋める identity placeholder を持つ', () => {
  for (const unit of [HUB_UNIT, COLLECTOR_UNIT, DASHBOARD_UNIT]) {
    expect(unit).toContain('User=CHANGE_ME')
    expect(unit).toContain('Group=CHANGE_ME')
  }
})

test('deploy upgrade removes only the obsolete collector interval', () => {
  expect(readDeployFile('deploy.sh')).toContain('remove_legacy_collector_interval')
  expect(readDeployFile('deploy.sh')).toMatch(
    /remove_legacy_collector_interval[\s\S]*COLLECTOR_INTERVAL_SECONDS=/
  )
  expect(readDeployFile('deploy.sh')).toContain(
    'remove_legacy_collector_interval "${LIMIT_MONITOR_ETC_DIR}/collector.env"'
  )
})

test('legacy collector cleanup accepts leading whitespace and CRLF', () => {
  const deploy = readDeployFile('deploy.sh')
  const source = [
    '  COLLECTOR_INTERVAL_SECONDS=60',
    'COLLECTOR_PROVIDERS=codex,claude',
    'COLLECTOR_INTERVAL_SECONDS=120\r',
    '# COLLECTOR_INTERVAL_SECONDS=comment',
    'SOURCE_ID=existing-host',
    ''
  ].join('\n')

  const rendered = runLegacyCollectorCleanup(deploy, source)

  expect(rendered).toBe(
    [
      'COLLECTOR_PROVIDERS=codex,claude',
      '# COLLECTOR_INTERVAL_SECONDS=comment',
      'SOURCE_ID=existing-host',
      ''
    ].join('\n')
  )
})

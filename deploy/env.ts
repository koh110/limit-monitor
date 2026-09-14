import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export class DeployConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeployConfigError'
  }
}

const REFRESH_TOKEN_PLACEHOLDER = 'replace-with-a-random-service-token'

type Assignment = {
  key: string
  value: string
  lineIndex: number
}

function splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = content.endsWith('\n')
  const lines = content.split('\n')
  if (trailingNewline) lines.pop()
  return { lines, trailingNewline }
}

function assignmentOf(line: string, lineIndex: number): Assignment | undefined {
  const trimmed = line.trimStart()
  if (trimmed.length === 0 || trimmed.startsWith('#')) return undefined
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed)
  if (match === null) return undefined
  return { key: match[1]!, value: match[2]!, lineIndex }
}

export function envAssignments(content: string): Assignment[] {
  const { lines } = splitLines(content)
  return lines.flatMap((line, index) => {
    const assignment = assignmentOf(line, index)
    return assignment === undefined ? [] : [assignment]
  })
}

export function duplicateEnvKeys(content: string): string[] {
  const counts = new Map<string, number>()
  for (const assignment of envAssignments(content)) {
    counts.set(assignment.key, (counts.get(assignment.key) ?? 0) + 1)
  }
  return [...counts].filter(([, count]) => count > 1).map(([key]) => key)
}

export function assertNoDuplicateEnvKeys(content: string, label = 'env file'): void {
  const duplicates = duplicateEnvKeys(content)
  if (duplicates.length > 0) {
    throw new DeployConfigError(`${label} has duplicate keys: ${duplicates.join(', ')}`)
  }
}

export function readEnvValue(content: string, key: string): string | undefined {
  assertNoDuplicateEnvKeys(content)
  return envAssignments(content).find((assignment) => assignment.key === key)?.value
}

function configuredRefreshToken(content: string): string | undefined {
  const value = (readEnvValue(content, 'HUB_REFRESH_TOKEN') ?? '').trim()
  if (value === '' || value === REFRESH_TOKEN_PLACEHOLDER) return undefined
  return value
}

function generateRefreshToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * HubとDashboardのserver-side refresh tokenを解決する。
 *
 * 両方が未設定またはexample placeholderなら、新しいtokenを一度だけ生成する。
 * 片側だけ設定済みなら既存値をもう片側へ反映し、両側の実値が異なる場合は
 * token単独では扱わず、配置対象envの内容にのみ反映する。
 */
export function prepareRefreshTokenEnvs(
  hubContent: string,
  dashboardContent: string,
  tokenGenerator: () => string = generateRefreshToken
): { hub: string; dashboard: string; generated: boolean } {
  const hubToken = configuredRefreshToken(hubContent)
  const dashboardToken = configuredRefreshToken(dashboardContent)

  if (hubToken !== undefined && dashboardToken !== undefined) {
    if (hubToken !== dashboardToken) {
      throw new DeployConfigError('HUB_REFRESH_TOKEN differs between hub and dashboard env')
    }
    return { hub: hubContent, dashboard: dashboardContent, generated: false }
  }

  const candidateToken = hubToken ?? dashboardToken ?? tokenGenerator()
  if (candidateToken.includes('\n') || candidateToken.includes('\r')) {
    throw new DeployConfigError('generated HUB_REFRESH_TOKEN must be a non-empty single-line value')
  }
  const token = candidateToken.trim()
  if (token === '' || token === REFRESH_TOKEN_PLACEHOLDER) {
    throw new DeployConfigError('generated HUB_REFRESH_TOKEN must be a non-empty single-line value')
  }

  return {
    hub:
      hubToken === undefined
        ? renderEnvUpdates(hubContent, { HUB_REFRESH_TOKEN: token }, 'hub.env')
        : hubContent,
    dashboard:
      dashboardToken === undefined
        ? renderEnvUpdates(dashboardContent, { HUB_REFRESH_TOKEN: token }, 'dashboard.env')
        : dashboardContent,
    generated: hubToken === undefined && dashboardToken === undefined
  }
}

/**
 * refresh tokenを保存するenvのmodeを安全側へ寄せる。
 * owner readが無い、group writeがある、またはother bitがある場合は0600にする。
 * 既存の640/600等は変更しない。存在しないファイルは配置処理に委ねる。
 */
export function ensureSecretEnvFileMode(file: string): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DeployConfigError(`secret env path must be a regular non-symlink file: ${file}`)
  }
  const mode = stat.mode & 0o777
  const secure = (mode & 0o400) !== 0 && (mode & 0o007) === 0 && (mode & 0o020) === 0
  if (!secure) fs.chmodSync(file, 0o600)

  const verified = fs.lstatSync(file)
  const verifiedMode = verified.mode & 0o777
  if (
    !verified.isFile() ||
    verified.isSymbolicLink() ||
    (verifiedMode & 0o400) === 0 ||
    (verifiedMode & 0o007) !== 0 ||
    (verifiedMode & 0o020) !== 0
  ) {
    throw new DeployConfigError(`secret env mode verification failed: ${file}`)
  }
}

export function renderEnvUpdates(
  content: string,
  updates: Readonly<Record<string, string>>,
  label = 'env file'
): string {
  assertNoDuplicateEnvKeys(content, label)
  const { lines, trailingNewline } = splitLines(content)
  const assignments = envAssignments(content)
  const byKey = new Map(assignments.map((assignment) => [assignment.key, assignment]))

  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new DeployConfigError(`invalid env key: ${key}`)
    }
    if (value.includes('\n') || value.includes('\r')) {
      throw new DeployConfigError(`${key} must be a single-line env value`)
    }
    const existing = byKey.get(key)
    if (existing === undefined) {
      if (lines.length > 0 && lines.at(-1)?.trim() !== '') lines.push('')
      lines.push(`${key}=${value}`)
    } else {
      lines[existing.lineIndex] = `${key}=${value}`
    }
  }

  const rendered = lines.join('\n')
  return trailingNewline || rendered.length > 0 ? `${rendered}\n` : rendered
}

export function renderCollectorProviders(content: string, providers: readonly string[]): string {
  if (providers.length === 0) {
    throw new DeployConfigError('collector providers must not be empty')
  }
  return renderEnvUpdates(content, { COLLECTOR_PROVIDERS: providers.join(',') }, 'collector.env')
}

export function removeEnvKeys(
  content: string,
  keys: readonly string[],
  label = 'env file'
): string {
  assertNoDuplicateEnvKeys(content, label)
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new DeployConfigError(`invalid env key: ${key}`)
    }
  }

  const remove = new Set(keys)
  const { lines, trailingNewline } = splitLines(content)
  const removeIndexes = new Set(
    envAssignments(content)
      .filter((assignment) => remove.has(assignment.key))
      .map((assignment) => assignment.lineIndex)
  )
  const rendered = lines.filter((_, index) => !removeIndexes.has(index)).join('\n')
  return trailingNewline || rendered.length > 0 ? `${rendered}\n` : rendered
}

export function readEnvFile(file: string): string {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DeployConfigError(`env path must be a regular non-symlink file: ${file}`)
  }
  return fs.readFileSync(file, 'utf8')
}

export function atomicWriteTextFile(file: string, content: string, defaultMode: number): boolean {
  const parent = path.dirname(file)
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 })

  let existing: fs.Stats | undefined
  if (fs.existsSync(file)) {
    existing = fs.lstatSync(file)
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new DeployConfigError(`refusing to replace non-regular file: ${file}`)
    }
    if (fs.readFileSync(file, 'utf8') === content) return false
  }

  const temp = path.join(parent, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: existing?.mode ?? defaultMode })
    if (existing !== undefined) {
      fs.chmodSync(temp, existing.mode & 0o7777)
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        fs.chownSync(temp, existing.uid, existing.gid)
      }
    } else {
      fs.chmodSync(temp, defaultMode)
    }
    fs.renameSync(temp, file)
    return true
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true })
  }
}

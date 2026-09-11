import fs from 'node:fs'
import path from 'node:path'

export class DeployConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeployConfigError'
  }
}

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

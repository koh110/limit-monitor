#!/usr/bin/env -S node --experimental-strip-types
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type ProviderTarget = 'codex' | 'claude' | 'grok'

const PROVIDERS = new Set<ProviderTarget>(['codex', 'claude', 'grok'])

function fail(message: string): never {
  throw new Error(message)
}

function isActiveAssignment(line: string, key: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed.startsWith(`${key}=`)
}

export function readEnvValue(content: string, key: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (isActiveAssignment(line, key)) return line.trimStart().slice(key.length + 1)
  }
  return undefined
}

export function assertNoDuplicateEnvKeys(content: string): void {
  const seen = new Set<string>()
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index)
    if (seen.has(key)) fail(`duplicate env key: ${key}`)
    seen.add(key)
  }
}

export function normalizeProviders(raw: string): string {
  const parts = raw.split(',').map((part) => part.trim())
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    fail('providers must contain at least one non-empty provider')
  }
  const seen = new Set<string>()
  for (const provider of parts) {
    if (!PROVIDERS.has(provider as ProviderTarget)) fail(`unknown provider: ${provider}`)
    if (seen.has(provider)) fail(`duplicate provider: ${provider}`)
    seen.add(provider)
  }
  return parts.join(',')
}

export function renderProviderEnv(content: string, rawProviders: string): string {
  assertNoDuplicateEnvKeys(content)
  const providers = normalizeProviders(rawProviders)
  const lines = content.split(/\r?\n/)
  let replaced = false
  for (let i = 0; i < lines.length; i += 1) {
    if (isActiveAssignment(lines[i] ?? '', 'COLLECTOR_PROVIDERS')) {
      lines[i] = `COLLECTOR_PROVIDERS=${providers}`
      replaced = true
      break
    }
  }
  if (!replaced) {
    if (lines.length > 0 && lines.at(-1) !== '') lines.push('')
    lines.push(`COLLECTOR_PROVIDERS=${providers}`)
  }
  return lines.join('\n')
}

export function renderProviderEnvFile(source: string, destination: string, rawProviders: string): void {
  const stat = fs.lstatSync(source)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`collector env source must be a regular file: ${source}`)
  const content = fs.readFileSync(source, 'utf8')
  const rendered = renderProviderEnv(content, rawProviders)
  fs.writeFileSync(destination, rendered, { mode: 0o600 })
}

export function installAtomic(source: string, destination: string, newFileMode = 0o640): void {
  const sourceStat = fs.lstatSync(source)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail(`collector env candidate must be a regular file: ${source}`)
  const candidate = fs.readFileSync(source)
  const parent = path.dirname(destination)
  fs.mkdirSync(parent, { recursive: true })

  if (!fs.existsSync(destination)) {
    const temp = fs.mkdtempSync(path.join(parent, '.collector-env-'))
    const staged = path.join(temp, 'collector.env')
    try {
      fs.writeFileSync(staged, candidate, { mode: newFileMode })
      fs.renameSync(staged, destination)
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
    return
  }

  const destinationStat = fs.lstatSync(destination)
  if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
    fail(`refusing to replace non-regular collector env: ${destination}`)
  }
  if (Buffer.compare(candidate, fs.readFileSync(destination)) === 0) return

  const tempPath = path.join(parent, `.collector.env.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`)
  try {
    fs.writeFileSync(tempPath, candidate, { mode: destinationStat.mode & 0o7777 })
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      fs.chownSync(tempPath, destinationStat.uid, destinationStat.gid)
    }
    fs.renameSync(tempPath, destination)
  } catch (error) {
    fs.rmSync(tempPath, { force: true })
    throw error
  }
}

function usage(): string {
  return [
    'provider-config.ts render <source-env> <candidate-env> <providers>',
    'provider-config.ts install <candidate-env> <destination-env> [mode-octal]'
  ].join('\n')
}

function main(argv: readonly string[]): void {
  try {
    const [command, ...args] = argv
    if (command === 'render') {
      if (args.length !== 3) fail(usage())
      renderProviderEnvFile(args[0]!, args[1]!, args[2]!)
      return
    }
    if (command === 'install') {
      if (args.length < 2 || args.length > 3) fail(usage())
      const mode = args[2] === undefined ? 0o640 : Number.parseInt(args[2], 8)
      if (!Number.isInteger(mode)) fail(`invalid mode: ${args[2]}`)
      installAtomic(args[0]!, args[1]!, mode)
      return
    }
    fail(usage())
  } catch (error) {
    process.stderr.write(`[provider-config] ERROR: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

const entry = process.argv[1]
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))

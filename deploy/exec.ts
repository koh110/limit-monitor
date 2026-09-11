import { spawnSync } from 'node:child_process'

export type ExecOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  inherit?: boolean
  allowFailure?: boolean
}

export type ExecResult = {
  status: number
  stdout: string
  stderr: string
}

export type CommandRunner = (
  command: string,
  args?: readonly string[],
  options?: ExecOptions
) => ExecResult

export class CommandError extends Error {
  readonly command: string
  readonly args: readonly string[]
  readonly status: number
  readonly stderr: string

  constructor(command: string, args: readonly string[], status: number, stderr: string) {
    super(
      `command failed (${status}): ${[command, ...args].join(' ')}${stderr.trim() === '' ? '' : `\n${stderr.trim()}`}`
    )
    this.name = 'CommandError'
    this.command = command
    this.args = args
    this.status = status
    this.stderr = stderr
  }
}

export const runCommand: CommandRunner = (command, args = [], options = {}) => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    shell: false
  })
  if (result.error !== undefined) throw result.error
  const status = result.status ?? 1
  const stdout = options.inherit ? '' : (result.stdout ?? '')
  const stderr = options.inherit ? '' : (result.stderr ?? '')
  if (status !== 0 && options.allowFailure !== true) {
    throw new CommandError(command, args, status, stderr)
  }
  return { status, stdout, stderr }
}

export type InstallIdentity = {
  user: string
  uid: number
  group: string
  gid: number
  home: string
  shell: string
}

export function runAsUser(
  runner: CommandRunner,
  identity: InstallIdentity,
  command: string,
  args: readonly string[],
  options: ExecOptions = {}
): ExecResult {
  const env = {
    ...process.env,
    ...options.env,
    HOME: identity.home,
    USER: identity.user,
    LOGNAME: identity.user,
    SHELL: identity.shell
  }
  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}=${value}`)

  return runner(
    'runuser',
    ['-u', identity.user, '--', 'env', ...envArgs, command, ...args],
    { ...options, env: process.env }
  )
}

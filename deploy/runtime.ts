import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DeployConfigError,
  assertNoDuplicateEnvKeys,
  atomicWriteTextFile,
  readEnvFile,
  readEnvValue,
  removeEnvKeys,
  renderCollectorProviders,
  renderEnvUpdates
} from './env.ts'
import { type CommandRunner, type InstallIdentity, runAsUser, runCommand } from './exec.ts'

export type DeployService = 'server' | 'collector'
export type DeployProvider = 'codex' | 'claude' | 'grok'

export type DeploymentRequest = {
  repoRoot: string
  services: readonly DeployService[]
  providers?: readonly DeployProvider[]
  hubBaseUrl: string
  force: boolean
  runner?: CommandRunner
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
}

type DeployPaths = {
  installDir: string
  versionsDir: string
  etcDir: string
  systemdDir: string
  stateDir: string
}

type PreparedConfig = {
  identity: InstallIdentity
  nodeBin: string
  envs: Partial<Record<'hub' | 'dashboard' | 'collector', string>>
  envDestinations: Partial<Record<'hub' | 'dashboard' | 'collector', string>>
  units: Map<string, string>
}

const NEW_MANAGED_UNIT_MARKER =
  '# limit-monitor: managed by deploy.ts -- do not edit (edit env instead)'
const LEGACY_MANAGED_UNIT_MARKER =
  '# limit-monitor: managed by deploy/deploy.sh -- do not edit (edit env instead)'
const MANAGED_UNIT_MARKERS = [NEW_MANAGED_UNIT_MARKER, LEGACY_MANAGED_UNIT_MARKER]

const REQUIRED_BUILD_ARTIFACTS = [
  'packages/shared/dist/src/index.js',
  'packages/hub/dist/src/index.js',
  'packages/hub/dist/src/features/tokens/store.js',
  'packages/collector/dist/src/agent.js',
  'packages/collector/dist/src/worker.js',
  'packages/client/dist/public/index.html',
  'packages/client/dist/server/index.js',
  'packages/client/dist/server/static-server.js'
] as const

const PACKAGE_STAGE_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  shared: ['dist'],
  hub: ['dist', 'drizzle', 'bin'],
  collector: ['dist'],
  client: ['dist']
}

function deployError(message: string): never {
  throw new DeployConfigError(message)
}

function validateUnixName(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(name)) {
    deployError(`${label} is not a valid account name: ${name}`)
  }
}

function parseInteger(value: string | undefined, fallback: number, label: string): number {
  const raw = value ?? String(fallback)
  if (!/^[0-9]+$/.test(raw)) deployError(`${label} must be a non-negative integer (got: ${raw})`)
  return Number(raw)
}

function resolvePaths(env: NodeJS.ProcessEnv): DeployPaths {
  const installDir = env.INSTALL_DIR ?? '/var/www/limit-monitor'
  if (!path.isAbsolute(installDir))
    deployError(`INSTALL_DIR must be an absolute path (got: ${installDir})`)
  if (installDir === '/') deployError('INSTALL_DIR must not be /')
  return {
    installDir,
    versionsDir: path.join(installDir, 'versions'),
    etcDir: env.LIMIT_MONITOR_ETC_DIR ?? '/etc/limit-monitor',
    systemdDir: env.LIMIT_MONITOR_SYSTEMD_DIR ?? '/etc/systemd/system',
    stateDir: env.LIMIT_MONITOR_STATE_DIR ?? '/var/lib/limit-monitor'
  }
}

export function resolveInstallIdentity(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
  euid = process.getuid?.() ?? -1
): InstallIdentity {
  let user = env.SUDO_USER
  if ((user === undefined || user === '' || user === 'root') && euid !== 0) {
    user = runner('id', ['-un']).stdout.trim()
  }
  if (user === undefined || user === '' || user === 'root') {
    deployError(
      "cannot determine the install user: run deployment through sudo from a normal account (for example 'sudo ./deploy.ts ...')"
    )
  }
  validateUnixName(user, 'install user')

  const passwd = runner('getent', ['passwd', user]).stdout.trim()
  if (passwd === '') deployError(`install user not found: ${user}`)
  const fields = passwd.split(':')
  if (fields.length < 7) deployError(`invalid passwd entry for install user: ${user}`)
  const uid = Number(fields[2])
  const gid = Number(fields[3])
  const home = fields[5] ?? ''
  const shell = fields[6] || '/bin/sh'
  if (!Number.isInteger(uid) || uid === 0) {
    deployError(`refusing to run limit-monitor services as uid 0 (${user})`)
  }
  if (!Number.isInteger(gid)) deployError(`invalid primary gid for install user: ${user}`)
  if (!path.isAbsolute(home) || !fs.existsSync(home) || !fs.statSync(home).isDirectory()) {
    deployError(`install user ${user} has no existing absolute home directory (got: ${home})`)
  }

  const groupEntry = runner('getent', ['group', String(gid)]).stdout.trim()
  if (groupEntry === '')
    deployError(`cannot resolve the primary group (gid ${gid}) of install user ${user}`)
  const groupFields = groupEntry.split(':')
  const group = groupFields[0] ?? ''
  validateUnixName(group, 'install group')
  const readBack = runner('getent', ['group', group]).stdout.trim().split(':')
  if (Number(readBack[2]) !== gid) {
    deployError(`install group ${group} does not resolve back to gid ${gid}`)
  }
  return { user, uid, group, gid, home, shell }
}

function validateNodeBinary(): string {
  const nodeBin = fs.realpathSync(process.execPath)
  if (!fs.existsSync(nodeBin) || (fs.statSync(nodeBin).mode & 0o111) === 0) {
    deployError(`node binary is not executable: ${nodeBin}`)
  }
  if (nodeBin.startsWith('/home/') || nodeBin.startsWith('/root/')) {
    deployError(
      `node path ${nodeBin} is under a user HOME; hub/dashboard units use ProtectHome=true. Use a node installed outside HOME`
    )
  }
  return nodeBin
}

function validateSemver(version: unknown): string {
  if (typeof version !== 'string') deployError('package.json version must be valid semver')
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version
    )
  const prerelease = match?.[4]?.split('.') ?? []
  const validPrerelease = prerelease.every(
    (part) => !/^[0-9]+$/.test(part) || !part.startsWith('0') || part === '0'
  )
  if (match === null || !validPrerelease) deployError('package.json version must be valid semver')
  return version
}

function runBuild(
  runner: CommandRunner,
  identity: InstallIdentity,
  repoRoot: string,
  hubBaseUrl: string,
  log: (message: string) => void
): void {
  log(`npm ci as ${identity.user}`)
  runAsUser(runner, identity, 'npm', ['ci'], { cwd: repoRoot, inherit: true })
  for (const workspace of ['shared', 'hub', 'collector']) {
    log(`building workspace: ${workspace}`)
    runAsUser(runner, identity, 'npm', ['run', 'build', '-w', workspace], {
      cwd: repoRoot,
      inherit: true
    })
  }
  log('building workspace: dashboard')
  runAsUser(runner, identity, 'npm', ['run', 'build', '-w', 'dashboard'], {
    cwd: repoRoot,
    inherit: true,
    env: { VITE_HUB_BASE_URL: hubBaseUrl }
  })
  for (const artifact of REQUIRED_BUILD_ARTIFACTS) {
    const full = path.join(repoRoot, artifact)
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      deployError(`build artifact missing: ${full}`)
    }
  }
}

/** releaseへコピーする際、workspace依存のsymlinkをrelease内の実体にする。 */
export function copyEntry(source: string, dest: string): void {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) {
    copyEntry(fs.realpathSync(source), dest)
    return
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true, mode: stat.mode & 0o7777 })
    for (const child of fs.readdirSync(source)) {
      copyEntry(path.join(source, child), path.join(dest, child))
    }
    fs.chmodSync(dest, stat.mode & 0o7777)
    return
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 })
  fs.copyFileSync(source, dest)
  fs.chmodSync(dest, stat.mode & 0o7777)
}

function chownTree(root: string, uid: number, gid: number): void {
  const visit = (entry: string): void => {
    const stat = fs.lstatSync(entry)
    if (!stat.isSymbolicLink()) fs.chownSync(entry, uid, gid)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    for (const child of fs.readdirSync(entry)) visit(path.join(entry, child))
  }
  visit(root)
}

function stageRelease(
  runner: CommandRunner,
  identity: InstallIdentity,
  repoRoot: string,
  log: (message: string) => void
): string {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-stage-'))
  for (const rootFile of ['package.json', 'package-lock.json']) {
    copyEntry(path.join(repoRoot, rootFile), path.join(stage, rootFile))
  }
  const npmrc = path.join(repoRoot, '.npmrc')
  if (fs.existsSync(npmrc)) copyEntry(npmrc, path.join(stage, '.npmrc'))

  for (const [pkg, entries] of Object.entries(PACKAGE_STAGE_ENTRIES)) {
    const packageDir = path.join(stage, 'packages', pkg)
    fs.mkdirSync(packageDir, { recursive: true, mode: 0o755 })
    copyEntry(
      path.join(repoRoot, 'packages', pkg, 'package.json'),
      path.join(packageDir, 'package.json')
    )
    for (const entry of entries) {
      const source = path.join(repoRoot, 'packages', pkg, entry)
      if (!fs.existsSync(source)) deployError(`missing ${pkg}/${entry}`)
      copyEntry(source, path.join(packageDir, entry))
    }
  }
  fs.mkdirSync(path.join(stage, 'deploy'), { recursive: true, mode: 0o755 })
  copyEntry(path.join(repoRoot, 'deploy', 'systemd'), path.join(stage, 'deploy', 'systemd'))
  for (const name of ['hub.env.example', 'collector.env.example', 'dashboard.env.example']) {
    copyEntry(path.join(repoRoot, 'deploy', name), path.join(stage, 'deploy', name))
  }

  chownTree(stage, identity.uid, identity.gid)
  log('installing production dependencies in staging as install user')
  runAsUser(runner, identity, 'npm', ['ci', '--omit=dev'], {
    cwd: stage,
    inherit: true
  })

  runner(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "await import('./packages/shared/dist/src/index.js')",
        "await import('./packages/hub/dist/src/app.js')",
        "await import('./packages/collector/dist/src/collect.js')",
        "await import('./packages/client/dist/server/static-server.js')"
      ].join(';')
    ],
    { cwd: stage }
  )
  runner(process.execPath, ['--experimental-strip-types', 'packages/hub/bin/tokens.ts', '--help'], {
    cwd: stage
  })
  return stage
}

function readExample(repoRoot: string, name: 'hub' | 'dashboard' | 'collector'): string {
  return fs.readFileSync(path.join(repoRoot, 'deploy', `${name}.env.example`), 'utf8')
}

function envSource(
  dest: string,
  example: string,
  installDir: string
): { content: string; existing: boolean } {
  if (fs.existsSync(dest)) {
    const content = readEnvFile(dest)
    assertNoDuplicateEnvKeys(content, dest)
    const configured = readEnvValue(content, 'INSTALL_DIR') ?? ''
    if (configured !== installDir) {
      deployError(`${dest} has INSTALL_DIR=${configured} but deploy INSTALL_DIR is ${installDir}`)
    }
    return { content, existing: true }
  }
  return {
    content: renderEnvUpdates(
      example,
      { INSTALL_DIR: installDir },
      `${path.basename(dest)} example`
    ),
    existing: false
  }
}

function isStrictOrigin(value: string): boolean {
  const match = /^https?:\/\/([^/?#@:]+)(?::([0-9]{1,5}))?$/.exec(value)
  if (match === null) return false
  if (match[2] !== undefined) {
    const port = Number(match[2])
    if (port < 1 || port > 65535) return false
  }
  return true
}

function dashboardOrigin(content: string, label: string): string {
  const host = (readEnvValue(content, 'HOST') ?? '127.0.0.1').trim()
  const port = (readEnvValue(content, 'PORT') ?? '8788').trim()
  let origin = (readEnvValue(content, 'DASHBOARD_PUBLIC_ORIGIN') ?? '').trim()
  if (origin === '') {
    if (host === '127.0.0.1' || host === 'localhost') origin = `http://${host}:${port}`
    else deployError(`DASHBOARD_PUBLIC_ORIGIN must be set in ${label} when HOST=${host}`)
  }
  if (!isStrictOrigin(origin)) {
    deployError(
      `DASHBOARD_PUBLIC_ORIGIN must be an origin (http://host or https://host, optional :port; got: ${origin})`
    )
  }
  return origin
}

function syncHubCors(content: string, origin: string, label: string): string {
  const raw = readEnvValue(content, 'CORS_ALLOWED_ORIGINS')
  if (raw === undefined || raw.trim() === '') {
    deployError(`${label} is missing CORS_ALLOWED_ORIGINS`)
  }
  const origins = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (!origins.includes(origin)) origins.push(origin)
  return renderEnvUpdates(content, { CORS_ALLOWED_ORIGINS: origins.join(',') }, label)
}

function parseProvidersFromEnv(content: string, label: string): DeployProvider[] {
  const raw = readEnvValue(content, 'COLLECTOR_PROVIDERS') ?? ''
  if (raw === '') deployError(`COLLECTOR_PROVIDERS is empty in ${label}`)
  if (raw.includes('"') || raw.includes("'")) {
    deployError(`COLLECTOR_PROVIDERS must not be quoted in ${label}`)
  }
  const providers: DeployProvider[] = []
  for (const part of raw.split(',')) {
    const provider = part.trim()
    if (provider === '') deployError(`COLLECTOR_PROVIDERS has an empty element in ${label}`)
    if (provider !== 'codex' && provider !== 'claude' && provider !== 'grok') {
      deployError(`COLLECTOR_PROVIDERS has an unknown provider '${provider}' in ${label}`)
    }
    if (providers.includes(provider)) {
      deployError(`COLLECTOR_PROVIDERS has a duplicate provider '${provider}' in ${label}`)
    }
    providers.push(provider)
  }
  return providers
}

function isExecutableAsUser(
  runner: CommandRunner,
  identity: InstallIdentity,
  file: string
): boolean {
  if (!path.isAbsolute(file)) return false
  return runAsUser(runner, identity, 'test', ['-x', file], { allowFailure: true }).status === 0
}

function candidateCliPaths(
  identity: InstallIdentity,
  cli: string,
  env: NodeJS.ProcessEnv
): string[] {
  const candidates = new Set<string>()
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '') candidates.add(path.join(dir, cli))
  }
  for (const dir of [
    path.join(identity.home, '.local', 'bin'),
    path.join(identity.home, '.npm-global', 'bin'),
    path.join(identity.home, '.volta', 'bin'),
    path.join(identity.home, '.bun', 'bin')
  ]) {
    candidates.add(path.join(dir, cli))
  }
  const nvmRoot = path.join(identity.home, '.nvm', 'versions', 'node')
  if (fs.existsSync(nvmRoot) && fs.statSync(nvmRoot).isDirectory()) {
    for (const version of fs.readdirSync(nvmRoot).sort().reverse()) {
      candidates.add(path.join(nvmRoot, version, 'bin', cli))
    }
  }
  return [...candidates]
}

function resolveInitialCli(
  runner: CommandRunner,
  identity: InstallIdentity,
  key: 'CODEX_BIN' | 'CLAUDE_BIN' | 'GROK_BIN',
  cli: 'codex' | 'claude' | 'grok',
  env: NodeJS.ProcessEnv
): string {
  const explicit = env[key]
  if (explicit !== undefined && explicit !== '') {
    if (!isExecutableAsUser(runner, identity, explicit)) {
      deployError(`${key} is not an executable in the ${identity.user} environment: ${explicit}`)
    }
    return explicit
  }
  const resolved = runAsUser(runner, identity, identity.shell, ['-lc', `command -v -- ${cli}`], {
    allowFailure: true
  }).stdout.trim()
  if (resolved !== '' && isExecutableAsUser(runner, identity, resolved)) return resolved
  for (const candidate of candidateCliPaths(identity, cli, env)) {
    if (isExecutableAsUser(runner, identity, candidate)) return candidate
  }
  deployError(
    `${cli} CLI not found in ${identity.user} environment; set ${key} to an absolute path`
  )
}

function validateCollectorEnv(
  runner: CommandRunner,
  identity: InstallIdentity,
  content: string,
  label: string
): { providers: DeployProvider[] } {
  assertNoDuplicateEnvKeys(content, label)
  const mode = readEnvValue(content, 'COLLECTOR_MODE') ?? 'real'
  if (mode !== 'real' && mode !== 'mock') {
    deployError(`COLLECTOR_MODE must be 'real' or 'mock' in ${label} (got: ${mode})`)
  }
  const providers = parseProvidersFromEnv(content, label)
  if (mode === 'real') {
    for (const provider of providers) {
      const key =
        provider === 'codex' ? 'CODEX_BIN' : provider === 'claude' ? 'CLAUDE_BIN' : 'GROK_BIN'
      const bin = readEnvValue(content, key) ?? ''
      if (!isExecutableAsUser(runner, identity, bin)) {
        deployError(
          `${provider} provider is enabled but ${key} is not an executable absolute path: ${bin}`
        )
      }
    }
  }
  return { providers }
}

export function prepareCollectorEnv(
  runner: CommandRunner,
  identity: InstallIdentity,
  repoRoot: string,
  dest: string,
  installDir: string,
  selected: readonly DeployProvider[] | undefined,
  env: NodeJS.ProcessEnv
): { content: string; existing: boolean } {
  const source = envSource(dest, readExample(repoRoot, 'collector'), installDir)
  let content = source.content
  if (source.existing) {
    content = removeEnvKeys(content, ['COLLECTOR_INTERVAL_SECONDS'], 'collector.env')
  }
  if (selected !== undefined) content = renderCollectorProviders(content, selected)
  const effectiveProviders = parseProvidersFromEnv(content, dest)
  const updates: Record<string, string> = {}
  if (!source.existing) {
    if (effectiveProviders.includes('codex')) {
      updates.CODEX_BIN = resolveInitialCli(runner, identity, 'CODEX_BIN', 'codex', env)
    }
    if (effectiveProviders.includes('claude')) {
      updates.CLAUDE_BIN = resolveInitialCli(runner, identity, 'CLAUDE_BIN', 'claude', env)
    }
  }
  if (effectiveProviders.includes('grok') && (readEnvValue(content, 'GROK_BIN') ?? '') === '') {
    updates.GROK_BIN = resolveInitialCli(runner, identity, 'GROK_BIN', 'grok', env)
  }
  if (Object.keys(updates).length > 0) content = renderEnvUpdates(content, updates, 'collector.env')
  validateCollectorEnv(runner, identity, content, dest)
  return { content, existing: source.existing }
}

function renderUnit(
  template: string,
  unitName: string,
  nodeBin: string,
  identity: InstallIdentity
): string {
  const userMatches = template.match(/^User=CHANGE_ME$/gm) ?? []
  const groupMatches = template.match(/^Group=CHANGE_ME$/gm) ?? []
  if (userMatches.length !== 1 || groupMatches.length !== 1) {
    deployError(`${unitName} must contain exactly one User=CHANGE_ME and Group=CHANGE_ME`)
  }
  let rendered = template
    .replace(/^ExecStart=\/usr\/bin\/node /m, `ExecStart=${nodeBin} `)
    .replace(/^User=CHANGE_ME$/m, `User=${identity.user}`)
    .replace(/^Group=CHANGE_ME$/m, `Group=${identity.group}`)
  if (/^(User|Group)=CHANGE_ME$/m.test(rendered)) {
    deployError(`${unitName} still contains CHANGE_ME placeholder`)
  }
  if (!rendered.includes('ExecStart=') || !rendered.includes('${INSTALL_DIR}')) {
    deployError(`${unitName} has an invalid ExecStart after rendering`)
  }
  if (rendered.includes('Environment=COLLECTOR_PROVIDERS=')) {
    // The template default is intentionally present before EnvironmentFile. What must never
    // appear is a deploy-option override after EnvironmentFile. Enforce a single template default.
    const providerLines = rendered.match(/^Environment=COLLECTOR_PROVIDERS=.*$/gm) ?? []
    if (providerLines.length !== (unitName === 'limit-monitor-collector.service' ? 1 : 0)) {
      deployError(`${unitName} contains an unexpected COLLECTOR_PROVIDERS unit override`)
    }
  }
  return rendered
}

function selectedUnitNames(services: readonly DeployService[]): string[] {
  const units: string[] = []
  if (services.includes('server')) {
    units.push('limit-monitor-hub.service', 'limit-monitor-dashboard.service')
  }
  if (services.includes('collector')) units.push('limit-monitor-collector.service')
  return units
}

function validateManagedDestination(file: string): void {
  if (!fs.existsSync(file)) return
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    deployError(`refusing to replace non-regular systemd unit: ${file}`)
  }
  const content = fs.readFileSync(file, 'utf8')
  if (!MANAGED_UNIT_MARKERS.some((marker) => content.includes(marker))) {
    deployError(`${file} is not a deploy-managed unit; reconcile it manually`)
  }
}

function validateStateDir(paths: DeployPaths, identity: InstallIdentity): void {
  if (!fs.existsSync(paths.stateDir)) return
  const stat = fs.lstatSync(paths.stateDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    deployError(`state path exists but is not a directory: ${paths.stateDir}`)
  }
  if (stat.uid !== identity.uid || stat.gid !== identity.gid) {
    deployError(
      `state directory ${paths.stateDir} has unexpected owner; expected ${identity.user}:${identity.group}`
    )
  }
  if ((stat.mode & 0o777) !== 0o755) {
    deployError(`state directory ${paths.stateDir} must have mode 755`)
  }
}

function validateCollectorToken(paths: DeployPaths): void {
  const token = path.join(paths.etcDir, 'collector-token')
  if (!fs.existsSync(token)) deployError(`missing collector token: ${token}`)
  const stat = fs.lstatSync(token)
  if (!stat.isFile() || stat.isSymbolicLink())
    deployError(`collector token must be a regular file: ${token}`)
  if ((stat.mode & 0o777) !== 0o600) deployError(`collector token must have mode 600: ${token}`)
  if (stat.uid !== 0) deployError(`collector token must be owned by root: ${token}`)
  if (fs.readFileSync(token, 'utf8').trim() === '')
    deployError(`collector token is empty: ${token}`)
}

function prepareConfig(
  runner: CommandRunner,
  request: DeploymentRequest,
  paths: DeployPaths,
  env: NodeJS.ProcessEnv,
  identity: InstallIdentity,
  nodeBin: string,
  log: (message: string) => void
): PreparedConfig {
  const envs: PreparedConfig['envs'] = {}
  const envDestinations: PreparedConfig['envDestinations'] = {}

  if (request.services.includes('server')) {
    const hubDest = path.join(paths.etcDir, 'hub.env')
    const dashboardDest = path.join(paths.etcDir, 'dashboard.env')
    const hub = envSource(hubDest, readExample(request.repoRoot, 'hub'), paths.installDir)
    const dashboard = envSource(
      dashboardDest,
      readExample(request.repoRoot, 'dashboard'),
      paths.installDir
    )
    const origin = dashboardOrigin(dashboard.content, dashboardDest)
    envs.hub = syncHubCors(hub.content, origin, hubDest)
    envs.dashboard = dashboard.content
    envDestinations.hub = hubDest
    envDestinations.dashboard = dashboardDest
    validateStateDir(paths, identity)
  }

  if (request.services.includes('collector')) {
    const collectorDest = path.join(paths.etcDir, 'collector.env')
    const collector = prepareCollectorEnv(
      runner,
      identity,
      request.repoRoot,
      collectorDest,
      paths.installDir,
      request.providers,
      env
    )
    envs.collector = collector.content
    envDestinations.collector = collectorDest

    validateCollectorToken(paths)
  }

  const units = new Map<string, string>()
  for (const unitName of selectedUnitNames(request.services)) {
    const template = fs.readFileSync(
      path.join(request.repoRoot, 'deploy', 'systemd', unitName),
      'utf8'
    )
    const rendered = renderUnit(template, unitName, nodeBin, identity)
    if (unitName === 'limit-monitor-collector.service') {
      const tokenPath = path.join(paths.etcDir, 'collector-token')
      const expected = `LoadCredential=hub-token:${tokenPath}`
      if (!rendered.includes(expected) && paths.etcDir === '/etc/limit-monitor') {
        deployError(`${unitName} must load the collector token through systemd credentials`)
      }
      if (!rendered.includes('Environment=HUB_TOKEN_FILE=%d/hub-token')) {
        deployError(
          `${unitName} must expose HUB_TOKEN_FILE through the systemd credential directory`
        )
      }
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-unit-'))
    try {
      const temp = path.join(tempDir, unitName)
      fs.writeFileSync(temp, rendered)
      runner('systemd-analyze', ['verify', temp])
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
    validateManagedDestination(path.join(paths.systemdDir, unitName))
    units.set(unitName, rendered)
    log(`validated ${unitName}`)
  }

  return { identity, nodeBin, envs, envDestinations, units }
}

function placeStateDir(
  paths: DeployPaths,
  identity: InstallIdentity,
  installServer: boolean
): void {
  fs.mkdirSync(paths.etcDir, { recursive: true, mode: 0o755 })
  if (!installServer) return
  if (!fs.existsSync(paths.stateDir)) fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o755 })
  fs.chownSync(paths.stateDir, identity.uid, identity.gid)
  fs.chmodSync(paths.stateDir, 0o755)
}

function placeManagedUnit(file: string, rendered: string): void {
  const content = `${NEW_MANAGED_UNIT_MARKER}\n${rendered}`
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8')
    const existingBody = existing
      .split('\n')
      .filter((line) => !MANAGED_UNIT_MARKERS.includes(line))
      .join('\n')
    if (existingBody === rendered) return
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '')
    fs.copyFileSync(file, `${file}.bak-${stamp}`)
  }
  atomicWriteTextFile(file, content, 0o644)
}

function placeConfig(
  request: DeploymentRequest,
  paths: DeployPaths,
  prepared: PreparedConfig,
  log: (message: string) => void
): void {
  placeStateDir(paths, prepared.identity, request.services.includes('server'))
  for (const [unit, rendered] of prepared.units) {
    const dest = path.join(paths.systemdDir, unit)
    placeManagedUnit(dest, rendered)
    log(`installed ${dest}`)
  }

  if (request.services.includes('server')) {
    const hubDest = prepared.envDestinations.hub!
    const dashboardDest = prepared.envDestinations.dashboard!
    atomicWriteTextFile(hubDest, prepared.envs.hub!, 0o644)
    if (!fs.existsSync(dashboardDest)) {
      atomicWriteTextFile(dashboardDest, prepared.envs.dashboard!, 0o644)
    }
  }

  if (request.services.includes('collector')) {
    const collectorDest = prepared.envDestinations.collector!
    const exists = fs.existsSync(collectorDest)
    const current = exists ? fs.readFileSync(collectorDest, 'utf8') : null
    if (!exists || request.providers !== undefined || current !== prepared.envs.collector) {
      atomicWriteTextFile(collectorDest, prepared.envs.collector!, 0o640)
      log(`persisted collector environment in ${collectorDest}`)
    }
  }
}

function placeRelease(
  stage: string,
  paths: DeployPaths,
  version: string,
  force: boolean,
  keepVersions: number,
  log: (message: string) => void
): void {
  const versionDir = path.join(paths.versionsDir, version)
  fs.mkdirSync(paths.versionsDir, { recursive: true, mode: 0o755 })
  let backup: string | undefined
  if (fs.existsSync(versionDir)) {
    if (!force)
      deployError(`version already exists: ${versionDir} (use --force to replace it explicitly)`)
    backup = path.join(paths.versionsDir, `.${version}.backup.${process.pid}`)
    if (fs.existsSync(backup)) deployError(`version backup path already exists: ${backup}`)
    fs.renameSync(versionDir, backup)
  }

  try {
    fs.mkdirSync(versionDir, { recursive: false, mode: 0o755 })
    copyEntry(stage, versionDir)
    fs.chmodSync(versionDir, 0o755)
    const tempLink = path.join(paths.installDir, '.current.new')
    fs.rmSync(tempLink, { force: true })
    fs.symlinkSync(versionDir, tempLink)
    fs.renameSync(tempLink, path.join(paths.installDir, 'current'))
    if (backup !== undefined) fs.rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    fs.rmSync(versionDir, { recursive: true, force: true })
    if (backup !== undefined && fs.existsSync(backup)) fs.renameSync(backup, versionDir)
    throw error
  }

  const current = fs.realpathSync(path.join(paths.installDir, 'current'))
  const versions = fs
    .readdirSync(paths.versionsDir)
    .filter((name) => !name.startsWith('.'))
    .sort()
    .reverse()
  for (const old of versions.slice(keepVersions)) {
    const candidate = path.join(paths.versionsDir, old)
    if (fs.realpathSync(candidate) === current) continue
    log(`pruning old release ${old}`)
    fs.rmSync(candidate, { recursive: true, force: true })
  }
}

function unitIsActive(runner: CommandRunner, unit: string): boolean {
  return runner('systemctl', ['is-active', unit], { allowFailure: true }).stdout.trim() === 'active'
}

function applyUnit(runner: CommandRunner, unit: string, log: (message: string) => void): void {
  log(`enabling ${unit}`)
  runner('systemctl', ['enable', unit])
  const enabled = runner('systemctl', ['is-enabled', '--quiet', unit], { allowFailure: true })
  if (enabled.status !== 0) deployError(`read-back failed: ${unit} is not enabled`)

  if (unitIsActive(runner, unit)) runner('systemctl', ['restart', unit])
  else runner('systemctl', ['start', unit])

  if (!unitIsActive(runner, unit)) deployError(`read-back failed: ${unit} is not active`)
}

function sleep(milliseconds: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(view, 0, 0, milliseconds)
}

function waitForHubReady(
  runner: CommandRunner,
  hubEnv: string,
  timeoutSeconds: number,
  log: (message: string) => void
): void {
  let host = (readEnvValue(hubEnv, 'HOST') ?? '127.0.0.1').trim()
  const port = (readEnvValue(hubEnv, 'PORT') ?? '8787').trim()
  if (host === '0.0.0.0' || host === '::' || host === '*') host = '127.0.0.1'
  if (!/^[0-9A-Za-z._:-]+$/.test(host)) deployError(`hub.env HOST is not valid: ${host}`)
  if (!/^[0-9]+$/.test(port)) deployError(`hub.env PORT is not valid: ${port}`)
  const url = `http://${host}:${port}/readyz`
  const deadline = Date.now() + timeoutSeconds * 1000
  let last = ''
  while (Date.now() <= deadline) {
    const result = runner('curl', ['-fsS', '--max-time', '3', url], { allowFailure: true })
    if (result.status === 0) {
      log(`hub ready: ${url}`)
      return
    }
    last = result.stderr.trim()
    if (Date.now() < deadline) sleep(1000)
  }
  deployError(`hub is not ready after ${timeoutSeconds}s: ${url}${last === '' ? '' : ` (${last})`}`)
}

function startServices(
  runner: CommandRunner,
  request: DeploymentRequest,
  prepared: PreparedConfig,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void
): void {
  runner('systemctl', ['daemon-reload'])
  if (request.services.includes('server')) {
    applyUnit(runner, 'limit-monitor-hub.service', log)
    waitForHubReady(
      runner,
      prepared.envs.hub!,
      parseInteger(
        env.LIMIT_MONITOR_HUB_READY_TIMEOUT_SECONDS,
        30,
        'LIMIT_MONITOR_HUB_READY_TIMEOUT_SECONDS'
      ),
      log
    )
    applyUnit(runner, 'limit-monitor-dashboard.service', log)
  }
  if (request.services.includes('collector')) {
    applyUnit(runner, 'limit-monitor-collector.service', log)
  }
}

export function performDeployment(request: DeploymentRequest): void {
  const runner = request.runner ?? runCommand
  const env = { ...process.env, ...request.env }
  const log = request.log ?? ((message: string) => process.stderr.write(`[deploy] ${message}\n`))
  const paths = resolvePaths(env)
  const keepVersions = parseInteger(env.KEEP_VERSIONS, 5, 'KEEP_VERSIONS')
  if (keepVersions < 1) deployError('KEEP_VERSIONS must be >= 1')
  if (!/^https?:\/\//.test(request.hubBaseUrl)) {
    deployError('VITE_HUB_BASE_URL must start with http:// or https://')
  }
  if (process.getuid?.() !== 0) deployError('systemd operations require root (run with sudo)')

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(request.repoRoot, 'package.json'), 'utf8')
  ) as {
    version?: unknown
  }
  const version = validateSemver(packageJson.version)
  const versionDir = path.join(paths.versionsDir, version)
  if (fs.existsSync(versionDir) && !request.force) {
    deployError(`version already exists: ${versionDir} (use --force to replace it explicitly)`)
  }

  const identity = resolveInstallIdentity(runner, env, 0)
  const nodeBin = validateNodeBinary()
  log(`resolved install identity: ${identity.user}:${identity.group}`)
  log(`resolved node for systemd units: ${nodeBin}`)

  let stage: string | undefined
  try {
    runBuild(runner, identity, request.repoRoot, request.hubBaseUrl, log)
    stage = stageRelease(runner, identity, request.repoRoot, log)

    // All /etc and release mutations happen after config/unit/token/CLI validations.
    const prepared = prepareConfig(runner, request, paths, env, identity, nodeBin, log)
    log('all read-only validations passed; proceeding to placement')

    placeConfig(request, paths, prepared, log)
    placeRelease(stage, paths, version, request.force, keepVersions, log)
    startServices(runner, request, prepared, env, log)
    log(`done: ${path.join(paths.installDir, 'current')} -> ${versionDir}`)
  } finally {
    if (stage !== undefined) fs.rmSync(stage, { recursive: true, force: true })
  }
}

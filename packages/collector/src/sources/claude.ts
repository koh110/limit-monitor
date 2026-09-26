import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildClaudeUsageObservation,
  parseClaudeUsagePayload,
  type ClaudeUsageLimit
} from '../adapters/claude-usage.js'
import type { ProviderReadInput, ProviderReadResult } from './types.js'

export type ClaudeSourceOptions = {
  credentialsFile: string
  usageUrl: string
  cacheFile: string
  timeoutMs: number
  maxResponseBytes: number
  cacheTtlMs: number
  userAgent?: string
  tokenUrl?: string
  oauthClientId?: string
  now?: () => number
}

type ClaudeUsageCache = {
  fetchedAtMs: number | null
  observedAt: string | null
  limits: ClaudeUsageLimit[]
  retryAtMs: number | null
}

type ClaudeApiResult =
  | { ok: true; limits: ClaudeUsageLimit[] }
  | { ok: false; reason: string; detail: string }

type ClaudeCredentialsResult =
  | {
      ok: true
      credentials: {
        document: Record<string, unknown>
        oauth: Record<string, unknown>
        fingerprint: string
        accessToken: string | null
        refreshToken: string | null
        scopes: string[]
        expiresAtMs: number | null
        refreshTokenExpiresAtMs: number | null
      }
    }
  | {
      ok: false
      reason:
        | 'credentials_unavailable'
        | 'invalid_credentials'
        | 'missing_access_token'
        | 'credentials_refresh_failed'
        | 'credentials_refresh_invalid_response'
        | 'credentials_persist_failed'
        | 'missing_usage_scope'
        | 'refresh_token_expired'
      detail: string
    }

type ClaudeRefreshResult =
  | {
      ok: true
      accessToken: string
      refreshToken: string
      scopes: string[]
      expiresAtMs: number
      refreshTokenExpiresAtMs: number | null
    }
  | {
      ok: false
      reason: 'credentials_refresh_failed' | 'credentials_refresh_invalid_response'
      detail: string
    }

const DEFAULT_CLAUDE_USAGE_USER_AGENT = 'claude-code/2.1.282'
const DEFAULT_CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const DEFAULT_CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000
const REQUIRED_CLAUDE_USAGE_SCOPE = 'user:profile'
const CREDENTIAL_LOCK_WAIT_MS = 50
const CREDENTIAL_LOCK_TIMEOUT_MS = 10 * 1000
const CREDENTIAL_LOCK_STALE_MS = 5 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseEpochMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function parseOAuthScopes(value: unknown): string[] | null {
  if (
    Array.isArray(value) &&
    value.every((scope) => typeof scope === 'string' && scope.length > 0)
  ) {
    return [...value]
  }
  if (typeof value === 'string') {
    const scopes = value.split(/\s+/).filter((scope) => scope.length > 0)
    return scopes.length > 0 ? scopes : null
  }
  return null
}

function fingerprintCredentials(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex')
}

type CredentialSwapJournal = {
  pid: number
  temporaryFile: string
  guardFile: string
  displacedFile: string
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

function lockOwnerPid(token: string): number | null {
  const match = /^(\d+)(?:\.|$)/.exec(token.trim())
  if (!match?.[1]) return null
  const pid = Number(match[1])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function recoverPendingCredentialSwap(credentialsFile: string, allowLivePid?: number): void {
  const journalFile = `${credentialsFile}.limit-monitor.swap`
  let journal: CredentialSwapJournal
  try {
    const raw = fs.readFileSync(journalFile, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      !isRecord(parsed) ||
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.temporaryFile !== 'string' ||
      typeof parsed.guardFile !== 'string' ||
      typeof parsed.displacedFile !== 'string'
    ) {
      return
    }
    journal = parsed as unknown as CredentialSwapJournal
    if (processIsAlive(journal.pid) && journal.pid !== allowLivePid) return
    const prefix = `${credentialsFile}.`
    if (
      !journal.temporaryFile.startsWith(prefix) ||
      !journal.guardFile.startsWith(prefix) ||
      !journal.displacedFile.startsWith(prefix)
    ) {
      return
    }
    const lockFile = `${credentialsFile}.limit-monitor.lock`
    try {
      const lockToken = fs.readFileSync(lockFile, 'utf8')
      if (lockOwnerPid(lockToken) === journal.pid && !processIsAlive(journal.pid)) {
        fs.unlinkSync(lockFile)
      }
    } catch {
      // The lock may already have been released or replaced.
    }
  } catch {
    return
  }

  try {
    if (!fs.existsSync(credentialsFile) && fs.existsSync(journal.displacedFile)) {
      try {
        fs.linkSync(journal.displacedFile, credentialsFile)
      } catch {
        if (!fs.existsSync(credentialsFile)) return
      }
    }
    for (const file of [journal.temporaryFile, journal.guardFile, journal.displacedFile]) {
      try {
        fs.unlinkSync(file)
      } catch {
        // The file may already have been removed or restored.
      }
    }
    fs.unlinkSync(journalFile)
  } catch {
    // Leave the journal for the next startup if recovery is incomplete.
  }
}

function readClaudeCredentials(credentialsFile: string): ClaudeCredentialsResult {
  recoverPendingCredentialSwap(credentialsFile)
  try {
    const link = fs.lstatSync(credentialsFile)
    if (link.isSymbolicLink()) {
      return {
        ok: false,
        reason: 'invalid_credentials',
        detail: 'Claude credentials path must not be a symlink'
      }
    }
    const stat = fs.statSync(credentialsFile)
    if (!stat.isFile()) {
      return {
        ok: false,
        reason: 'invalid_credentials',
        detail: 'Claude credentials path must be a regular file'
      }
    }
    const uid = process.getuid?.()
    if (
      uid !== undefined &&
      (stat.uid !== uid || (stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0)
    ) {
      return {
        ok: false,
        reason: 'invalid_credentials',
        detail: 'Claude credentials file has insecure ownership or permissions'
      }
    }
  } catch {
    return {
      ok: false,
      reason: 'credentials_unavailable',
      detail: 'Claude credentials file metadata is unavailable'
    }
  }
  let raw: string
  try {
    raw = fs.readFileSync(credentialsFile, 'utf8')
  } catch (error) {
    return {
      ok: false,
      reason: 'credentials_unavailable',
      detail: `failed to read Claude credentials: ${error instanceof Error ? error.message : 'unknown error'}`
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      reason: 'invalid_credentials',
      detail: 'Claude credentials are not valid JSON'
    }
  }
  if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) {
    return {
      ok: false,
      reason: 'invalid_credentials',
      detail: 'Claude OAuth credentials are missing'
    }
  }
  const oauth = parsed.claudeAiOauth
  const accessToken =
    typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0 ? oauth.accessToken : null
  const refreshToken =
    typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0
      ? oauth.refreshToken
      : null
  const scopes = parseOAuthScopes(oauth.scopes)
  if (scopes === null || !scopes.includes(REQUIRED_CLAUDE_USAGE_SCOPE)) {
    return {
      ok: false,
      reason: 'missing_usage_scope',
      detail: `Claude OAuth credentials must include the ${REQUIRED_CLAUDE_USAGE_SCOPE} scope`
    }
  }
  return {
    ok: true,
    credentials: {
      document: parsed,
      oauth,
      fingerprint: fingerprintCredentials(raw),
      accessToken,
      refreshToken,
      scopes,
      expiresAtMs: parseEpochMs(oauth.expiresAt),
      refreshTokenExpiresAtMs: parseEpochMs(oauth.refreshTokenExpiresAt)
    }
  }
}

function parseCachedLimits(value: unknown): ClaudeUsageLimit[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const limits: ClaudeUsageLimit[] = []
  for (const rawLimit of value) {
    if (!isRecord(rawLimit)) {
      continue
    }
    const bucketId = rawLimit.bucketId
    const label = rawLimit.label
    const usedPercent = rawLimit.usedPercent
    const windowDurationSeconds = rawLimit.windowDurationSeconds
    const resetsAt = rawLimit.resetsAt
    if (
      typeof bucketId !== 'string' ||
      typeof label !== 'string' ||
      typeof usedPercent !== 'number' ||
      !Number.isFinite(usedPercent) ||
      (windowDurationSeconds !== null && typeof windowDurationSeconds !== 'number') ||
      (resetsAt !== null && typeof resetsAt !== 'string')
    ) {
      continue
    }
    limits.push({
      bucketId,
      label,
      usedPercent,
      windowDurationSeconds,
      resetsAt
    })
  }
  return limits
}

function readUsageCache(cacheFile: string): ClaudeUsageCache | null {
  try {
    const link = fs.lstatSync(cacheFile)
    if (link.isSymbolicLink()) return null
    const stat = fs.statSync(cacheFile)
    const uid = process.getuid?.()
    if (!stat.isFile() || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) {
      return null
    }
  } catch {
    return null
  }
  let raw: string
  try {
    raw = fs.readFileSync(cacheFile, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  const limits = parseCachedLimits(parsed.limits)
  if (limits === null) {
    return null
  }
  const fetchedAtMs = parsed.fetchedAtMs
  const observedAt = parsed.observedAt
  const retryAtMs = parsed.retryAtMs
  if (
    (fetchedAtMs !== null && (typeof fetchedAtMs !== 'number' || !Number.isFinite(fetchedAtMs))) ||
    (observedAt !== null &&
      (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt)))) ||
    (retryAtMs !== null && (typeof retryAtMs !== 'number' || !Number.isFinite(retryAtMs)))
  ) {
    return null
  }
  return {
    fetchedAtMs,
    observedAt,
    limits,
    retryAtMs
  }
}

function writeUsageCache(cacheFile: string, cache: ClaudeUsageCache): void {
  const temporaryFile = `${cacheFile}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(temporaryFile, JSON.stringify(cache), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    fs.renameSync(temporaryFile, cacheFile)
  } catch {
    try {
      fs.unlinkSync(temporaryFile)
    } catch {
      // Cache failure must not discard a successful live API response.
    }
  }
}

function cacheObservedAt(observedAt: string, nowMs: number): string {
  return Number.isNaN(Date.parse(observedAt)) ? new Date(nowMs).toISOString() : observedAt
}

function buildObservation({
  limits,
  sourceId,
  observedAt
}: {
  limits: readonly ClaudeUsageLimit[]
  sourceId: string
  observedAt: string
}): ProviderReadResult {
  const observation = buildClaudeUsageObservation({ limits, sourceId, observedAt })
  return observation
    ? { ok: true, observation }
    : {
        ok: false,
        reason: 'no_rate_limits',
        detail: 'claude usage API returned no usable rate limit window'
      }
}

type ResponseBodyResult =
  | { ok: true; body: string }
  | { ok: false; reason: 'response_too_large' | 'response_read_failed'; detail: string }

async function readResponseBody(
  response: Response,
  maxResponseBytes: number
): Promise<ResponseBodyResult> {
  if (response.body === null) {
    try {
      const body = await response.text()
      return Buffer.byteLength(body, 'utf8') > maxResponseBytes
        ? {
            ok: false,
            reason: 'response_too_large',
            detail: `Claude OAuth response exceeded ${maxResponseBytes} bytes`
          }
        : { ok: true, body }
    } catch {
      return {
        ok: false,
        reason: 'response_read_failed',
        detail: 'Claude OAuth response could not be read'
      }
    }
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxResponseBytes) {
        await reader.cancel()
        return {
          ok: false,
          reason: 'response_too_large',
          detail: `Claude OAuth response exceeded ${maxResponseBytes} bytes`
        }
      }
      chunks.push(chunk.value)
    }
  } catch {
    try {
      await reader.cancel()
    } catch {
      // The stream may already be closed.
    }
    return {
      ok: false,
      reason: 'response_read_failed',
      detail: 'Claude OAuth response stream could not be read'
    }
  } finally {
    reader.releaseLock()
  }
  return { ok: true, body: Buffer.concat(chunks).toString('utf8') }
}

async function requestUsage({
  accessToken,
  usageUrl,
  timeoutMs,
  maxResponseBytes,
  userAgent
}: {
  accessToken: string
  usageUrl: string
  timeoutMs: number
  maxResponseBytes: number
  userAgent?: string
}): Promise<ClaudeApiResult> {
  let response: Response
  try {
    response = await fetch(usageUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': userAgent ?? DEFAULT_CLAUDE_USAGE_USER_AGENT,
        'anthropic-beta': 'oauth-2025-04-20'
      }
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'usage_api_request_failed',
      detail: error instanceof Error ? error.message : 'Claude usage API request failed'
    }
  }

  if (response.status === 401 || response.status === 403) {
    try {
      await response.body?.cancel()
    } catch {
      // The auth failure is already sufficient for the typed result.
    }
    return {
      ok: false,
      reason: 'usage_api_auth_failed',
      detail: `Claude usage API rejected the OAuth credential with status ${response.status}`
    }
  }
  const bodyResult = await readResponseBody(response, maxResponseBytes)
  if (!bodyResult.ok) {
    return {
      ok: false,
      reason:
        bodyResult.reason === 'response_too_large'
          ? 'usage_api_response_too_large'
          : 'usage_api_response_read_failed',
      detail: bodyResult.detail
    }
  }
  const body = bodyResult.body
  if (response.status === 429) {
    return {
      ok: false,
      reason: 'usage_api_rate_limited',
      detail: 'Claude usage API rate limited the request'
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: 'usage_api_http_error',
      detail: `Claude usage API returned status ${response.status}`
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {
      ok: false,
      reason: 'invalid_json',
      detail: 'Claude usage API response is not valid JSON'
    }
  }
  return parseClaudeUsagePayload(parsed)
}

async function requestTokenRefresh({
  refreshToken,
  scopes,
  tokenUrl,
  oauthClientId,
  timeoutMs,
  maxResponseBytes,
  userAgent,
  nowMs
}: {
  refreshToken: string
  scopes: readonly string[]
  tokenUrl: string
  oauthClientId: string
  timeoutMs: number
  maxResponseBytes: number
  userAgent?: string
  nowMs: number
}): Promise<ClaudeRefreshResult> {
  let response: Response
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': userAgent ?? DEFAULT_CLAUDE_USAGE_USER_AGENT
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: oauthClientId,
        scope: scopes.join(' ')
      })
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'credentials_refresh_failed',
      detail: error instanceof Error ? error.message : 'Claude OAuth token refresh failed'
    }
  }

  const bodyResult = await readResponseBody(response, maxResponseBytes)
  if (!bodyResult.ok) {
    return {
      ok: false,
      reason: 'credentials_refresh_failed',
      detail: bodyResult.detail
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: 'credentials_refresh_failed',
      detail: `Claude OAuth token refresh returned status ${response.status}`
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyResult.body)
  } catch {
    return {
      ok: false,
      reason: 'credentials_refresh_invalid_response',
      detail: 'Claude OAuth token refresh response is not valid JSON'
    }
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.access_token !== 'string' ||
    parsed.access_token.length === 0
  ) {
    return {
      ok: false,
      reason: 'credentials_refresh_invalid_response',
      detail: 'Claude OAuth token refresh response has no access token'
    }
  }
  const expiresIn = parsed.expires_in
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return {
      ok: false,
      reason: 'credentials_refresh_invalid_response',
      detail: 'Claude OAuth token refresh response has no valid expiry'
    }
  }
  const expiresAtMs = nowMs + expiresIn * 1000
  if (!Number.isFinite(expiresAtMs)) {
    return {
      ok: false,
      reason: 'credentials_refresh_invalid_response',
      detail: 'Claude OAuth token refresh response expiry overflows'
    }
  }
  const nextRefreshToken =
    typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0
      ? parsed.refresh_token
      : refreshToken
  const refreshTokenExpiresIn = parsed.refresh_token_expires_in
  const hasRefreshTokenExpiryField = Object.prototype.hasOwnProperty.call(
    parsed,
    'refresh_token_expires_in'
  )
  if (
    hasRefreshTokenExpiryField &&
    (typeof refreshTokenExpiresIn !== 'number' ||
      !Number.isFinite(refreshTokenExpiresIn) ||
      refreshTokenExpiresIn <= 0)
  ) {
    return {
      ok: false,
      reason: 'credentials_refresh_invalid_response',
      detail: 'Claude OAuth token refresh response has an invalid refresh-token expiry'
    }
  }
  const refreshTokenExpiresAtMs =
    typeof refreshTokenExpiresIn === 'number' ? nowMs + refreshTokenExpiresIn * 1000 : null
  if (refreshTokenExpiresAtMs !== null && !Number.isFinite(refreshTokenExpiresAtMs)) {
    return {
      ok: false,
      reason: 'credentials_refresh_invalid_response',
      detail: 'Claude OAuth token refresh response refresh-token expiry overflows'
    }
  }
  const hasScopeField = Object.prototype.hasOwnProperty.call(parsed, 'scope')
  const refreshedScopes = parseOAuthScopes(parsed.scope)
  if (hasScopeField && refreshedScopes === null) {
    return {
      ok: false,
      reason: 'credentials_refresh_invalid_response',
      detail: 'Claude OAuth token refresh response has an invalid scope'
    }
  }
  const nextScopes = refreshedScopes ?? [...scopes]
  if (!nextScopes.includes(REQUIRED_CLAUDE_USAGE_SCOPE)) {
    return {
      ok: false,
      reason: 'credentials_refresh_invalid_response',
      detail: `Claude OAuth token refresh response lacks the ${REQUIRED_CLAUDE_USAGE_SCOPE} scope`
    }
  }
  return {
    ok: true,
    accessToken: parsed.access_token,
    refreshToken: nextRefreshToken,
    scopes: nextScopes,
    expiresAtMs,
    refreshTokenExpiresAtMs
  }
}

function inodeMatches(left: string, right: string): boolean {
  try {
    const leftStat = fs.statSync(left)
    const rightStat = fs.statSync(right)
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
  } catch {
    return false
  }
}

function writeRefreshedCredentials({
  credentialsFile,
  credentials,
  refreshed,
  expectedFingerprint
}: {
  credentialsFile: string
  credentials: Extract<ClaudeCredentialsResult, { ok: true }>['credentials']
  refreshed: Extract<ClaudeRefreshResult, { ok: true }>
  expectedFingerprint: string
}): string | null {
  const document = {
    ...credentials.document,
    claudeAiOauth: {
      ...credentials.oauth,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      scopes: refreshed.scopes,
      expiresAt: refreshed.expiresAtMs,
      ...(refreshed.refreshTokenExpiresAtMs === null
        ? {}
        : { refreshTokenExpiresAt: refreshed.refreshTokenExpiresAtMs })
    }
  }
  const nonce = `${process.pid}.${crypto.randomUUID()}`
  const temporaryFile = `${credentialsFile}.${nonce}.tmp`
  const guardFile = `${credentialsFile}.${nonce}.guard`
  const displacedFile = `${credentialsFile}.${nonce}.displaced`
  const journalFile = `${credentialsFile}.limit-monitor.swap`
  let displaced = false
  let committed = false
  let journalCreated = false
  try {
    recoverPendingCredentialSwap(credentialsFile)
    if (fs.lstatSync(credentialsFile).isSymbolicLink()) {
      return null
    }
    fs.mkdirSync(path.dirname(credentialsFile), { recursive: true, mode: 0o700 })
    // Keep a hard link to the exact inode that passed the initial check. If a
    // different writer replaces the path before the swap, inode comparison
    // below fails closed instead of overwriting its newer credentials.
    fs.linkSync(credentialsFile, guardFile)
    const currentRaw = fs.readFileSync(credentialsFile, 'utf8')
    if (fingerprintCredentials(currentRaw) !== expectedFingerprint) {
      return null
    }
    const serialized = JSON.stringify(document)
    fs.writeFileSync(temporaryFile, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    const journalPayload = JSON.stringify({
      pid: process.pid,
      temporaryFile,
      guardFile,
      displacedFile
    })
    fs.writeFileSync(journalFile, journalPayload, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    journalCreated = true
    const journalFd = fs.openSync(journalFile, 'r')
    try {
      fs.fsyncSync(journalFd)
    } finally {
      fs.closeSync(journalFd)
    }
    if (fingerprintCredentials(fs.readFileSync(guardFile, 'utf8')) !== expectedFingerprint) {
      return null
    }
    fs.renameSync(credentialsFile, displacedFile)
    displaced = true
    const guardStat = fs.statSync(guardFile)
    const displacedStat = fs.statSync(displacedFile)
    if (
      guardStat.dev !== displacedStat.dev ||
      guardStat.ino !== displacedStat.ino ||
      fingerprintCredentials(fs.readFileSync(guardFile, 'utf8')) !== expectedFingerprint
    ) {
      return null
    }
    // linkSync is atomic and does not replace a path created by another
    // writer while the original inode was temporarily displaced.
    fs.linkSync(temporaryFile, credentialsFile)
    if (fingerprintCredentials(fs.readFileSync(guardFile, 'utf8')) !== expectedFingerprint) {
      if (inodeMatches(credentialsFile, temporaryFile)) {
        fs.unlinkSync(credentialsFile)
        fs.linkSync(guardFile, credentialsFile)
      }
      return null
    }
    committed = true
    return fingerprintCredentials(serialized)
  } catch {
    return null
  } finally {
    let safeToCleanup = true
    if (displaced && !committed) {
      let targetExists = false
      try {
        targetExists = fs.existsSync(credentialsFile)
        if (targetExists && inodeMatches(credentialsFile, temporaryFile)) {
          fs.unlinkSync(credentialsFile)
          targetExists = false
        }
      } catch {
        safeToCleanup = false
      }
      if (!targetExists && safeToCleanup) {
        try {
          fs.linkSync(displacedFile, credentialsFile)
          targetExists = true
        } catch {
          targetExists = fs.existsSync(credentialsFile)
        }
      }
      if (!targetExists) {
        safeToCleanup = false
      }
    }
    if (safeToCleanup) {
      for (const file of [temporaryFile, guardFile, displacedFile]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // The file may already have been linked or removed during cleanup.
        }
      }
      if (journalCreated) {
        try {
          fs.unlinkSync(journalFile)
        } catch {
          // Leave an incomplete journal for the next startup to inspect.
        }
      }
    }
  }
}

async function withCredentialRefreshLock(
  credentialsFile: string,
  operation: () => Promise<ClaudeCredentialsResult>
): Promise<ClaudeCredentialsResult> {
  const lockFile = `${credentialsFile}.limit-monitor.lock`
  const deadline = Date.now() + CREDENTIAL_LOCK_TIMEOUT_MS
  for (;;) {
    const lockToken = `${process.pid}.${crypto.randomUUID()}`
    let lockFd: number | null = null
    try {
      lockFd = fs.openSync(lockFile, 'wx', 0o600)
      fs.writeFileSync(lockFd, lockToken, 'utf8')
      try {
        return await operation()
      } finally {
        try {
          fs.closeSync(lockFd)
        } catch {
          // The descriptor may already be closed after an I/O failure.
        }
        try {
          if (fs.readFileSync(lockFile, 'utf8') === lockToken) {
            fs.unlinkSync(lockFile)
          }
        } catch {
          // A concurrent cleanup or process shutdown may have removed it.
        }
      }
    } catch (error) {
      if (lockFd !== null) {
        try {
          fs.closeSync(lockFd)
        } catch {
          // Ignore cleanup failures.
        }
        try {
          if (fs.readFileSync(lockFile, 'utf8') === lockToken) {
            fs.unlinkSync(lockFile)
          }
        } catch {
          // The lock may have been removed by a stale-lock recovery.
        }
      }
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        return {
          ok: false,
          reason: 'credentials_refresh_failed',
          detail: 'Claude OAuth refresh lock could not be created'
        }
      }
      try {
        const stat = fs.statSync(lockFile)
        const observedToken = fs.readFileSync(lockFile, 'utf8')
        const ownerPid = lockOwnerPid(observedToken)
        const ownerAlive = ownerPid !== null && processIsAlive(ownerPid)
        const stale = Date.now() - stat.mtimeMs > CREDENTIAL_LOCK_STALE_MS
        if ((ownerPid !== null && !ownerAlive) || (ownerPid === null && stale)) {
          const latestToken = fs.readFileSync(lockFile, 'utf8')
          if (observedToken === latestToken) {
            fs.unlinkSync(lockFile)
            continue
          }
        }
      } catch {
        // The lock owner may have released it between open and stat.
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          reason: 'credentials_refresh_failed',
          detail: 'Claude OAuth refresh lock remained busy'
        }
      }
      await new Promise((resolve) => setTimeout(resolve, CREDENTIAL_LOCK_WAIT_MS))
    }
  }
}

async function resolveAccessToken({
  credentialsFile,
  tokenUrl,
  oauthClientId,
  timeoutMs,
  maxResponseBytes,
  userAgent,
  nowMs,
  forceRefresh = false
}: {
  credentialsFile: string
  tokenUrl?: string
  oauthClientId?: string
  timeoutMs: number
  maxResponseBytes: number
  userAgent?: string
  nowMs: number
  forceRefresh?: boolean
}): Promise<ClaudeCredentialsResult> {
  const initial = readClaudeCredentials(credentialsFile)
  if (!initial.ok) return initial
  const hasUsableAccessToken =
    initial.credentials.accessToken !== null &&
    (initial.credentials.expiresAtMs === null || initial.credentials.expiresAtMs > nowMs)
  const shouldRefresh =
    initial.credentials.accessToken === null ||
    (initial.credentials.expiresAtMs !== null &&
      initial.credentials.expiresAtMs <= nowMs + TOKEN_REFRESH_SKEW_MS)
  if (!forceRefresh && !shouldRefresh && initial.credentials.accessToken !== null) {
    return initial
  }
  if (initial.credentials.refreshToken === null) {
    if (forceRefresh && hasUsableAccessToken) {
      return {
        ok: false,
        reason: 'credentials_refresh_failed',
        detail: 'Claude OAuth credential has no refresh token'
      }
    }
    if (hasUsableAccessToken) return initial
    return {
      ok: false,
      reason: 'missing_access_token',
      detail: 'Claude OAuth access token is missing or expired'
    }
  }
  if (
    initial.credentials.refreshTokenExpiresAtMs !== null &&
    initial.credentials.refreshTokenExpiresAtMs <= nowMs
  ) {
    if (!forceRefresh && hasUsableAccessToken) return initial
    return {
      ok: false,
      reason: 'refresh_token_expired',
      detail: 'Claude OAuth refresh token is expired; run claude auth login'
    }
  }

  return withCredentialRefreshLock(credentialsFile, async () => {
    const latest = readClaudeCredentials(credentialsFile)
    if (!latest.ok) return latest
    const latestHasUsableAccessToken =
      latest.credentials.accessToken !== null &&
      (latest.credentials.expiresAtMs === null || latest.credentials.expiresAtMs > nowMs)
    const latestShouldRefresh =
      latest.credentials.accessToken === null ||
      (latest.credentials.expiresAtMs !== null &&
        latest.credentials.expiresAtMs <= nowMs + TOKEN_REFRESH_SKEW_MS)
    if (!forceRefresh && !latestShouldRefresh && latest.credentials.accessToken !== null) {
      return latest
    }
    if (
      forceRefresh &&
      latest.credentials.accessToken !== null &&
      latest.credentials.accessToken !== initial.credentials.accessToken &&
      latestHasUsableAccessToken
    ) {
      return latest
    }
    if (latest.credentials.refreshToken === null) {
      if (!forceRefresh && latestHasUsableAccessToken) return latest
      if (forceRefresh && latestHasUsableAccessToken) {
        return {
          ok: false,
          reason: 'credentials_refresh_failed',
          detail: 'Claude OAuth credential has no refresh token'
        }
      }
      return {
        ok: false,
        reason: 'missing_access_token',
        detail: 'Claude OAuth access token is missing or expired'
      }
    }
    if (
      latest.credentials.refreshTokenExpiresAtMs !== null &&
      latest.credentials.refreshTokenExpiresAtMs <= nowMs
    ) {
      if (!forceRefresh && latestHasUsableAccessToken) return latest
      return {
        ok: false,
        reason: 'refresh_token_expired',
        detail: 'Claude OAuth refresh token is expired; run claude auth login'
      }
    }

    const refreshed = await requestTokenRefresh({
      refreshToken: latest.credentials.refreshToken,
      scopes: latest.credentials.scopes,
      tokenUrl: tokenUrl ?? DEFAULT_CLAUDE_TOKEN_URL,
      oauthClientId: oauthClientId ?? DEFAULT_CLAUDE_OAUTH_CLIENT_ID,
      timeoutMs,
      maxResponseBytes,
      userAgent,
      nowMs
    })
    if (!refreshed.ok) {
      if (!forceRefresh && latestHasUsableAccessToken) return latest
      return refreshed
    }
    let persistedFingerprint = writeRefreshedCredentials({
      credentialsFile,
      credentials: latest.credentials,
      refreshed,
      expectedFingerprint: latest.credentials.fingerprint
    })
    if (persistedFingerprint === null) {
      // A failed swap may have left this process's journal behind. Recover it
      // before retrying once against the credentials that are actually on disk.
      recoverPendingCredentialSwap(credentialsFile, process.pid)
      const afterFailure = readClaudeCredentials(credentialsFile)
      if (
        afterFailure.ok &&
        afterFailure.credentials.refreshToken === latest.credentials.refreshToken
      ) {
        persistedFingerprint = writeRefreshedCredentials({
          credentialsFile,
          credentials: afterFailure.credentials,
          refreshed,
          expectedFingerprint: afterFailure.credentials.fingerprint
        })
      } else if (
        afterFailure.ok &&
        afterFailure.credentials.refreshToken !== latest.credentials.refreshToken
      ) {
        // Another writer already changed the credential; fail closed rather than
        // using or overwriting a token outside this refresh transaction.
        return {
          ok: false,
          reason: 'credentials_persist_failed',
          detail: 'Claude OAuth credentials changed while saving the refreshed token'
        }
      }
    }
    if (persistedFingerprint === null) {
      return {
        ok: false,
        reason: 'credentials_persist_failed',
        detail: 'Claude OAuth token was refreshed but could not be saved safely'
      }
    }
    return {
      ok: true,
      credentials: {
        ...latest.credentials,
        fingerprint: persistedFingerprint,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        scopes: refreshed.scopes,
        expiresAtMs: refreshed.expiresAtMs,
        refreshTokenExpiresAtMs:
          refreshed.refreshTokenExpiresAtMs ?? latest.credentials.refreshTokenExpiresAtMs
      }
    }
  })
}

function markBackoff({
  cache,
  nowMs,
  cacheTtlMs
}: {
  cache: ClaudeUsageCache | null
  nowMs: number
  cacheTtlMs: number
}): ClaudeUsageCache {
  return {
    fetchedAtMs: cache?.fetchedAtMs ?? null,
    observedAt: cache?.observedAt ?? null,
    limits: cache?.limits ?? [],
    retryAtMs: nowMs + cacheTtlMs
  }
}

/**
 * Claude Code の -p `/usage` は slash command ではなく通常の prompt として
 * 実行されるため、率制限値は undocumented OAuth usage API から取得する。
 * API 応答は cacheTtlMs の間だけ再利用し、undocumented endpoint の rate limit を
 * 毎分叩かない。cache には usage 数値だけを保存し OAuth token は保存しない。
 */
export function createClaudeReader(options: ClaudeSourceOptions) {
  return async ({ sourceId, observedAt }: ProviderReadInput): Promise<ProviderReadResult> => {
    const nowMs = options.now?.() ?? Date.now()
    const cache = readUsageCache(options.cacheFile)
    if (cache?.retryAtMs !== null && cache?.retryAtMs !== undefined && nowMs < cache.retryAtMs) {
      return {
        ok: false,
        reason: 'usage_api_backoff',
        detail: 'Claude usage API backoff is active after a previous failed request'
      }
    }
    if (
      cache?.fetchedAtMs !== null &&
      cache?.fetchedAtMs !== undefined &&
      cache.observedAt !== null &&
      nowMs - cache.fetchedAtMs < options.cacheTtlMs &&
      cache.limits.length > 0
    ) {
      return buildObservation({ limits: cache.limits, sourceId, observedAt: cache.observedAt })
    }

    const credentials = await resolveAccessToken({
      credentialsFile: options.credentialsFile,
      tokenUrl: options.tokenUrl,
      oauthClientId: options.oauthClientId,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      userAgent: options.userAgent,
      nowMs
    })
    if (!credentials.ok) {
      writeUsageCache(
        options.cacheFile,
        markBackoff({ cache, nowMs, cacheTtlMs: options.cacheTtlMs })
      )
      return credentials
    }
    if (credentials.credentials.accessToken === null) {
      writeUsageCache(
        options.cacheFile,
        markBackoff({ cache, nowMs, cacheTtlMs: options.cacheTtlMs })
      )
      return {
        ok: false,
        reason: 'missing_access_token',
        detail: 'Claude OAuth access token is missing after credential refresh'
      }
    }
    let api = await requestUsage({
      accessToken: credentials.credentials.accessToken,
      usageUrl: options.usageUrl,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      userAgent: options.userAgent
    })
    if (
      !api.ok &&
      api.reason === 'usage_api_auth_failed' &&
      credentials.credentials.refreshToken !== null
    ) {
      const refreshed = await resolveAccessToken({
        credentialsFile: options.credentialsFile,
        tokenUrl: options.tokenUrl,
        oauthClientId: options.oauthClientId,
        timeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
        userAgent: options.userAgent,
        nowMs,
        forceRefresh: true
      })
      if (!refreshed.ok) {
        writeUsageCache(
          options.cacheFile,
          markBackoff({ cache, nowMs, cacheTtlMs: options.cacheTtlMs })
        )
        return refreshed
      }
      const refreshedAccessToken = refreshed.credentials.accessToken
      if (refreshedAccessToken === null) {
        writeUsageCache(
          options.cacheFile,
          markBackoff({ cache, nowMs, cacheTtlMs: options.cacheTtlMs })
        )
        return {
          ok: false,
          reason: 'missing_access_token',
          detail: 'Claude OAuth access token is missing after forced refresh'
        }
      }
      api = await requestUsage({
        accessToken: refreshedAccessToken,
        usageUrl: options.usageUrl,
        timeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
        userAgent: options.userAgent
      })
    }
    if (!api.ok) {
      writeUsageCache(
        options.cacheFile,
        markBackoff({ cache, nowMs, cacheTtlMs: options.cacheTtlMs })
      )
      return api
    }

    const normalizedObservedAt = cacheObservedAt(observedAt, nowMs)
    writeUsageCache(options.cacheFile, {
      fetchedAtMs: nowMs,
      observedAt: normalizedObservedAt,
      limits: api.limits,
      retryAtMs: null
    })
    return buildObservation({ limits: api.limits, sourceId, observedAt: normalizedObservedAt })
  }
}

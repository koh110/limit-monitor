import os from 'node:os'
import path from 'node:path'
import type { Provider } from 'shared/src/contracts'
import { providerSchema } from 'shared/src/contracts'

export const HUB_URL = process.env.HUB_URL ?? 'http://127.0.0.1:8787'

// 開発用の平文 token。運用では HUB_TOKEN_FILE(systemd LoadCredential)を使う
export const HUB_TOKEN = process.env.HUB_TOKEN ?? null

export const HUB_TOKEN_FILE = process.env.HUB_TOKEN_FILE ?? null

// 人間が設定する端末別名(hostname の自動送信はしない。仕様 6.2)
export const SOURCE_ID = process.env.SOURCE_ID ?? 'mock-dev'

// accountAlias は collector では設定しない。Hub が認証 token に紐づく
// accountAlias を採用して正規化する

export const COLLECTOR_VERSION = '0.1.0' as const

/**
 * collector の動作モード。
 * - `real`(既定): 手元にインストールされた Codex CLI / Claude Code の OAuth credentials / Grok Build から実値を取得する
 * - `mock`: fixture を送信する。明示的に指定した場合のみ有効
 *
 * 未知の値は起動時に落とす(誤設定を黙って real/mock のどちらかに寄せない)。
 */
export type CollectorMode = 'real' | 'mock'

export function resolveCollectorMode(raw: string | undefined): CollectorMode {
  const trimmed = (raw ?? '').trim()
  if (trimmed.length === 0) {
    return 'real'
  }
  if (trimmed === 'real' || trimmed === 'mock') {
    return trimmed
  }
  throw new Error(`COLLECTOR_MODE must be "real" or "mock" (got: "${trimmed}")`)
}

/** 送信対象 provider。未知の provider 名は起動時に落とす */
export function resolveProviders(raw: string | undefined): Provider[] {
  // Grok は opt-in。既存 install で Grok CLI 未導入のまま upgrade しても壊さない。
  const trimmed = (raw ?? 'codex,claude').trim()
  const names = trimmed
    .split(',')
    .map((provider) => {
      return provider.trim()
    })
    .filter((provider) => {
      return provider.length > 0
    })
  if (names.length === 0) {
    throw new Error('COLLECTOR_PROVIDERS must list at least one provider')
  }
  const providers: Provider[] = []
  for (const name of names) {
    const parsed = providerSchema.safeParse(name)
    if (!parsed.success) {
      throw new Error(`COLLECTOR_PROVIDERS contains an unknown provider: "${name}"`)
    }
    if (!providers.includes(parsed.data)) {
      providers.push(parsed.data)
    }
  }
  return providers
}

/** 数値環境変数を検証して解決する。不正値は起動時に落とす */
export function resolveNonNegativeInt({
  raw,
  fallback,
  name
}: {
  raw: string | undefined
  fallback: number
  name: string
}): number {
  const trimmed = (raw ?? '').trim()
  if (trimmed.length === 0) {
    return fallback
  }
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (got: "${trimmed}")`)
  }
  return value
}

export function resolvePositiveInt({
  raw,
  fallback,
  name
}: {
  raw: string | undefined
  fallback: number
  name: string
}): number {
  const value = resolveNonNegativeInt({ raw, fallback, name })
  if (value === 0) {
    throw new Error(`${name} must be a positive integer (got: "0")`)
  }
  return value
}

export const COLLECTOR_MODE = resolveCollectorMode(process.env.COLLECTOR_MODE)

export const PROVIDERS = resolveProviders(process.env.COLLECTOR_PROVIDERS)

// vendor CLI の実行 path。systemd 配下では PATH が細いため明示指定できるようにする
export const CODEX_BIN = process.env.CODEX_BIN ?? 'codex'
export const GROK_BIN = process.env.GROK_BIN ?? 'grok'

// Claude Code の OAuth usage API は Claude Code が保存した credentials を使う。
// CLAUDE_CONFIG_DIR を指定した場合は Claude Code と同じ配置規則に合わせる。
export const CLAUDE_CREDENTIALS_FILE =
  process.env.CLAUDE_CREDENTIALS_FILE ??
  path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    '.credentials.json'
  )
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage' as const
export const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token' as const
// Claude Code の公開 OAuth client id。secret ではなく、CLI と同じ値を使う。
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e' as const
export const CLAUDE_USAGE_CACHE_FILE =
  process.env.CLAUDE_USAGE_CACHE_FILE ?? path.join(os.tmpdir(), 'limit-monitor-claude-usage.json')
export const CLAUDE_USAGE_CACHE_TTL_MS = resolvePositiveInt({
  raw: process.env.CLAUDE_USAGE_CACHE_TTL_MS,
  // undocumented endpoint は短時間の polling で 429 になり得るため、Hub の
  // 通常の trigger 間隔(60秒)より長く cache する。
  fallback: 5 * 60 * 1000,
  name: 'CLAUDE_USAGE_CACHE_TTL_MS'
})
export const CLAUDE_USAGE_USER_AGENT = process.env.CLAUDE_USAGE_USER_AGENT ?? 'claude-code/2.1.282'

// vendor CLI 実行の有限 timeout。CLI の cold start を見込んで既定 60 秒
export const COMMAND_TIMEOUT_MS = resolvePositiveInt({
  raw: process.env.COLLECTOR_COMMAND_TIMEOUT_MS,
  fallback: 60_000,
  name: 'COLLECTOR_COMMAND_TIMEOUT_MS'
})

// stdout の上限。想定応答は数 KB なので 1MB あれば十分に余裕がある
export const MAX_STDOUT_BYTES = resolvePositiveInt({
  raw: process.env.COLLECTOR_MAX_STDOUT_BYTES,
  fallback: 1024 * 1024,
  name: 'COLLECTOR_MAX_STDOUT_BYTES'
})

// Hub への 1 件の fetch の finite timeout。応答は通常数 ms だが Hub が
// 応答しなくなった場合の保険として既定 30 秒(0 は指定不可)
export const SEND_TIMEOUT_MS = resolvePositiveInt({
  raw: process.env.COLLECTOR_SEND_TIMEOUT_MS,
  fallback: 30_000,
  name: 'COLLECTOR_SEND_TIMEOUT_MS'
})

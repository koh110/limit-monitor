export const HUB_URL = process.env.HUB_URL ?? 'http://127.0.0.1:8787'

// 開発用の平文 token。運用では HUB_TOKEN_FILE(systemd LoadCredential)を使う
export const HUB_TOKEN = process.env.HUB_TOKEN ?? null

export const HUB_TOKEN_FILE = process.env.HUB_TOKEN_FILE ?? null

// 人間が設定する端末別名(hostname の自動送信はしない。仕様 6.2)
export const SOURCE_ID = process.env.SOURCE_ID ?? 'mock-dev'

// 人間が設定する非機密のアカウント別名(生のアカウントIDは禁止。仕様 6.2)
export const ACCOUNT_ALIAS = process.env.ACCOUNT_ALIAS ?? 'default'

// 0 なら 1 回送信して終了する
export const INTERVAL_SECONDS = process.env.COLLECTOR_INTERVAL_SECONDS
  ? Number(process.env.COLLECTOR_INTERVAL_SECONDS)
  : 0

export const PROVIDERS = (process.env.COLLECTOR_PROVIDERS ?? 'codex,claude')
  .split(',')
  .map((provider) => {
    return provider.trim()
  })
  .filter((provider) => {
    return provider.length > 0
  })

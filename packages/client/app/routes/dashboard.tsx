import { useEffect, useRef, useState } from 'react'
import { useRevalidator } from 'react-router'
import { AccountCard } from '../components/AccountCard'
import { AutoRefresh } from '../components/AutoRefresh'
import { REFRESH_INTERVAL_MS } from '../constants'
import { fetchStatus } from '../lib/api-client'
import { formatJst } from '../lib/format'
import { refreshAccount, type RefreshAccountResult } from '../lib/refresh-account'
import type { Route } from './+types/dashboard'

// ssr: false のため取得はブラウザ側で行う(clientLoader)。
export function clientLoader() {
  return fetchStatus()
}

export default function Dashboard({ loaderData: result }: Route.ComponentProps) {
  const { revalidate } = useRevalidator()
  const [refreshAllState, setRefreshAllState] = useState<
    'idle' | 'updating' | RefreshAccountResult
  >('idle')
  const refreshAllController = useRef<AbortController | null>(null)
  const now = new Date()
  const refreshingAll = refreshAllState === 'updating'

  useEffect(() => {
    return () => {
      refreshAllController.current?.abort()
    }
  }, [])

  async function refreshAll() {
    if (!result.ok || result.body.accounts.length === 0 || refreshingAll) return
    const controller = new AbortController()
    refreshAllController.current = controller
    const deadline = Date.now() + 5 * 60 * 1000
    setRefreshAllState('updating')
    try {
      const outcomes = await Promise.all(
        result.body.accounts.map((account) => refreshAccount(account, controller.signal, deadline))
      )
      if (controller.signal.aborted) return
      if (outcomes.every((outcome) => outcome === 'completed')) {
        setRefreshAllState('idle')
      } else {
        revalidate()
        setRefreshAllState(
          outcomes.includes('timeout')
            ? 'timeout'
            : outcomes.includes('offline')
              ? 'offline'
              : 'failed'
        )
        return
      }
      revalidate()
    } finally {
      if (refreshAllController.current === controller) {
        refreshAllController.current = null
      }
    }
  }

  const refreshAllMessage =
    refreshAllState === 'updating'
      ? 'すべてのアカウントを更新中…'
      : refreshAllState === 'failed'
        ? '一部のアカウントを更新できませんでした'
        : refreshAllState === 'offline'
          ? 'Hub に接続できませんでした'
          : refreshAllState === 'timeout'
            ? 'すべてのアカウントの更新がタイムアウトしました'
            : undefined

  return (
    <main className="dashboard">
      <AutoRefresh intervalMs={REFRESH_INTERVAL_MS} onRefresh={revalidate} />
      <header className="dashboard-head">
        <div className="dashboard-title">
          <h1>Limit Monitor</h1>
          <span
            className={`refresh-all-status refresh-all-status-${refreshAllState}`}
            role="status"
          >
            {refreshAllMessage}
          </span>
        </div>
        <button
          className="refresh-all-button"
          type="button"
          onClick={refreshAll}
          disabled={!result.ok || result.body.accounts.length === 0 || refreshingAll}
          aria-busy={refreshingAll}
        >
          {refreshingAll ? '更新中…' : 'すべてのアカウントを更新'}
        </button>
        {/* Result 型の絞り込みが必要なため条件分岐で描画する */}
        {result.ok ? (
          <p className="hub-state hub-online">
            Hub 接続中 · {formatJst(result.body.generatedAt)} JST
          </p>
        ) : (
          <p className="hub-state hub-offline">Hub OFFLINE</p>
        )}
      </header>
      {result.ok ? (
        result.body.accounts.length === 0 ? (
          <section className="empty">
            <p className="empty-value">--</p>
            <p>まだ有効な観測値がありません(never)</p>
            <p className="empty-hint">collector から観測値が届くとここに表示されます</p>
          </section>
        ) : (
          <div className="cards">
            {result.body.accounts.map((account) => {
              return (
                <AccountCard
                  key={`${account.provider}:${account.accountAlias}`}
                  account={account}
                  now={now}
                  onRefresh={revalidate}
                  refreshDisabled={refreshingAll}
                />
              )
            })}
          </div>
        )
      ) : (
        <section className="empty offline">
          <p className="empty-value">OFFLINE</p>
          <p>Limit Hub へ接続できません</p>
          <p className="empty-hint">
            Hub の稼働状態と VITE_HUB_BASE_URL を確認してください(60 秒ごとに自動で再試行します)
          </p>
        </section>
      )}
    </main>
  )
}

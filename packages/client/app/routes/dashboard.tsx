import { useRevalidator } from 'react-router'
import { AccountCard } from '../components/AccountCard'
import { AutoRefresh } from '../components/AutoRefresh'
import { REFRESH_INTERVAL_MS } from '../constants'
import { fetchStatus } from '../lib/api-client'
import { formatJst } from '../lib/format'
import type { Route } from './+types/dashboard'

// ssr: false のため取得はブラウザ側で行う(clientLoader)。
export function clientLoader() {
  return fetchStatus()
}

export default function Dashboard({ loaderData: result }: Route.ComponentProps) {
  const { revalidate } = useRevalidator()
  const now = new Date()

  return (
    <main className="dashboard">
      <AutoRefresh intervalMs={REFRESH_INTERVAL_MS} onRefresh={revalidate} />
      <header className="dashboard-head">
        <h1>Limit Monitor</h1>
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

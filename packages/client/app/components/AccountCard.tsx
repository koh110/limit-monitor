import { Activity, useEffect, useRef, useState } from 'react'
import type { StatusAccount, StatusBucket } from 'shared/src/contracts'
import { displayTone } from 'shared/src/remaining'
import { formatAgo, formatJst, formatUntilReset } from '../lib/format'
import { refreshAccount } from '../lib/refresh-account'

const FRESHNESS_LABELS = {
  fresh: '最新',
  stale: 'stale',
  expired: '期限切れ'
} as const

const FRESHNESS_PRIORITY = {
  fresh: 0,
  stale: 1,
  expired: 2
} as const

const PROVIDER_LABELS = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok'
} as const

type RefreshState = 'idle' | 'updating' | 'failed' | 'offline' | 'timeout'

function getAccountFreshness(account: StatusAccount): StatusBucket['freshness'] | undefined {
  return account.buckets.reduce<StatusBucket['freshness'] | undefined>((current, bucket) => {
    if (
      current === undefined ||
      FRESHNESS_PRIORITY[bucket.freshness] > FRESHNESS_PRIORITY[current]
    ) {
      return bucket.freshness
    }
    return current
  }, undefined)
}

function FreshnessBadge({ freshness }: { freshness: StatusBucket['freshness'] | undefined }) {
  if (!freshness) return null
  return (
    <span
      className={`freshness freshness-${freshness}`}
      aria-label={`鮮度: ${FRESHNESS_LABELS[freshness]}`}
    >
      {FRESHNESS_LABELS[freshness]}
    </span>
  )
}

function BucketRow({ bucket, now }: { bucket: StatusBucket; now: Date }) {
  const tone = displayTone({
    freshness: bucket.freshness,
    remainingPercent: bucket.remainingPercent
  })
  return (
    <li className={`bucket tone-${tone}`}>
      <div className="bucket-head">
        <span className="bucket-label">{bucket.label}</span>
      </div>
      <p className="remaining">
        <span className="remaining-caption">残り</span>
        <span className="remaining-value">{bucket.remainingPercent}%</span>
        {/* limit 到達はベンダー由来のフラグがある場合のみ表示する(型の絞り込み) */}
        {bucket.reached ? <span className="reached">上限到達</span> : null}
      </p>
      <div
        className="meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={bucket.remainingPercent}
        aria-label={`${bucket.label} 残量`}
      >
        <div className="meter-fill" style={{ width: `${bucket.remainingPercent}%` }} />
      </div>
      <dl className="bucket-meta">
        <div>
          <dt>使用済み</dt>
          <dd>{bucket.usedPercent}%</dd>
        </div>
        <div>
          <dt>リセット</dt>
          <dd>
            {formatJst(bucket.resetsAt)}
            <span className="until-reset">{formatUntilReset(bucket.resetsAt, now)}</span>
          </dd>
        </div>
        <div>
          <dt>最終観測</dt>
          <dd>
            {formatJst(bucket.observedAt)}
            <span className="until-reset">{formatAgo(bucket.observedAt, now)}</span>
          </dd>
        </div>
      </dl>
    </li>
  )
}

export function AccountCard({
  account,
  now,
  onRefresh,
  refreshDisabled = false
}: {
  account: StatusAccount
  now: Date
  onRefresh: () => void
  refreshDisabled?: boolean
}) {
  const [refreshState, setRefreshState] = useState<RefreshState>('idle')
  const refreshController = useRef<AbortController | null>(null)
  const refreshing = refreshState === 'updating'
  const accountFreshness = getAccountFreshness(account)

  useEffect(() => {
    return () => {
      refreshController.current?.abort()
    }
  }, [])

  async function refresh() {
    if (refreshing || refreshDisabled) return
    setRefreshState('updating')
    const controller = new AbortController()
    refreshController.current = controller
    const signal = controller.signal
    try {
      const result = await refreshAccount(account, signal)
      if (signal.aborted) return
      if (result === 'completed') onRefresh()
      setRefreshState(result === 'completed' ? 'idle' : result)
    } catch {
      if (signal.aborted) return
      setRefreshState('offline')
    } finally {
      if (refreshController.current === controller) {
        refreshController.current = null
      }
    }
  }

  const refreshMessage =
    refreshState === 'failed'
      ? 'Refresh failed'
      : refreshState === 'offline'
        ? 'Hub offline'
        : refreshState === 'timeout'
          ? 'Refresh timed out'
          : undefined
  const refreshStatus = refreshing ? 'Updating...' : refreshMessage
  const refreshStatusState = refreshing ? 'updating' : refreshState

  return (
    <section className="card">
      <header className="card-head">
        <div className="card-heading">
          <h2 className={`provider provider-${account.provider}`}>
            {PROVIDER_LABELS[account.provider]}
          </h2>
          <span className="alias">{account.accountAlias}</span>
          <Activity mode={accountFreshness ? 'visible' : 'hidden'}>
            <FreshnessBadge freshness={accountFreshness} />
          </Activity>
        </div>
        <div className="card-actions">
          <Activity mode={refreshStatus ? 'visible' : 'hidden'}>
            <span className={`refresh-status refresh-status-${refreshStatusState}`} role="status">
              {refreshStatus}
            </span>
          </Activity>
          <button
            className="refresh-button"
            type="button"
            onClick={refresh}
            disabled={refreshing || refreshDisabled}
            aria-label={`${account.accountAlias}を更新`}
            aria-busy={refreshing}
            title={refreshing ? '更新中' : '今すぐ更新'}
          >
            <svg
              className={`refresh-icon${refreshing ? ' refresh-icon-spinning' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path d="M20 11a8 8 0 0 0-14.8-4.3L3 9" />
              <path d="M3 4v5h5" />
              <path d="M4 13a8 8 0 0 0 14.8 4.3L21 15" />
              <path d="M21 20v-5h-5" />
            </svg>
          </button>
        </div>
      </header>
      <ul className="buckets">
        {account.buckets.map((bucket) => {
          return <BucketRow key={bucket.bucketId} bucket={bucket} now={now} />
        })}
      </ul>
    </section>
  )
}

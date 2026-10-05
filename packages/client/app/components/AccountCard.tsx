import { Activity, useEffect, useRef, useState } from 'react'
import {
  MAX_BUCKETS_PER_OBSERVATION,
  type StatusAccount,
  type StatusBucket
} from 'shared/src/contracts'
import { displayTone } from 'shared/src/remaining'
import { formatAgo, formatJst, formatUntilReset } from '../lib/format'
import { refreshAccount } from '../lib/refresh-account'
import { saveBucketOrder } from '../lib/api-client'

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
type BucketOrderSaveState = 'idle' | 'saving' | 'failed'
type BucketMoveDirection = 'up' | 'down'

const RING_VIEWBOX_SIZE = 120
const RING_CENTER = RING_VIEWBOX_SIZE / 2
const RING_OUTER_RADIUS = 52
const RING_INNER_RADIUS = 18
const RING_COLOR_COUNT = MAX_BUCKETS_PER_OBSERVATION

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

function getBucketTone(bucket: StatusBucket) {
  return displayTone({
    freshness: bucket.freshness,
    remainingPercent: bucket.remainingPercent
  })
}

function getRingRadius(index: number, bucketCount: number) {
  if (bucketCount <= 1) return RING_OUTER_RADIUS
  const radiusRange = RING_OUTER_RADIUS - RING_INNER_RADIUS
  return RING_OUTER_RADIUS - (index * radiusRange) / (bucketCount - 1)
}

function getRingStrokeWidth(bucketCount: number) {
  const ringSpacing =
    bucketCount <= 1
      ? RING_OUTER_RADIUS - RING_INNER_RADIUS
      : (RING_OUTER_RADIUS - RING_INNER_RADIUS) / (bucketCount - 1)
  return Math.max(2, Math.min(9, ringSpacing * 0.72))
}

function getRingColorIndex(index: number) {
  return index % RING_COLOR_COUNT
}

function orderBuckets(buckets: StatusBucket[], bucketOrder: string[]) {
  const bucketsById = new Map(
    buckets.map((bucket) => {
      return [bucket.bucketId, bucket] as const
    })
  )
  const orderedBuckets: StatusBucket[] = []
  const orderedIds = new Set<string>()
  for (const bucketId of bucketOrder) {
    const bucket = bucketsById.get(bucketId)
    if (bucket && !orderedIds.has(bucketId)) {
      orderedBuckets.push(bucket)
      orderedIds.add(bucketId)
    }
  }
  for (const bucket of buckets) {
    if (!orderedIds.has(bucket.bucketId)) {
      orderedBuckets.push(bucket)
      orderedIds.add(bucket.bucketId)
    }
  }
  return orderedBuckets
}

function BucketRing({
  bucket,
  index,
  bucketCount
}: {
  bucket: StatusBucket
  index: number
  bucketCount: number
}) {
  const tone = getBucketTone(bucket)
  const colorIndex = getRingColorIndex(index)
  const radius = getRingRadius(index, bucketCount)
  const strokeWidth = getRingStrokeWidth(bucketCount)

  return (
    <div
      className={`bucket-ring bucket-color-${colorIndex} tone-${tone}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={bucket.remainingPercent}
      aria-valuetext={`${bucket.remainingPercent}% 残り`}
      aria-label={`${bucket.label} 残量`}
    >
      <svg
        className="bucket-ring-svg"
        viewBox={`0 0 ${RING_VIEWBOX_SIZE} ${RING_VIEWBOX_SIZE}`}
        aria-hidden="true"
        focusable="false"
      >
        <circle
          className="bucket-ring-track"
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={radius}
          pathLength={100}
          strokeWidth={strokeWidth}
        />
        <circle
          className="bucket-ring-progress"
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={radius}
          pathLength={100}
          strokeDasharray={`${bucket.remainingPercent} 100`}
          strokeWidth={strokeWidth}
        />
      </svg>
    </div>
  )
}

function BucketRingOverview({
  buckets,
  now,
  onMove,
  moveDisabled
}: {
  buckets: StatusBucket[]
  now: Date
  onMove: (bucketId: string, direction: BucketMoveDirection) => void
  moveDisabled: boolean
}) {
  return (
    <section className="bucket-overview" aria-label="アカウントの残量">
      <div className="bucket-rings">
        {buckets.map((bucket, index) => {
          return (
            <BucketRing
              key={bucket.bucketId}
              bucket={bucket}
              index={index}
              bucketCount={buckets.length}
            />
          )
        })}
      </div>
      <ul className="bucket-legend" aria-label="残量一覧">
        {buckets.map((bucket, index) => {
          const tone = getBucketTone(bucket)
          const colorIndex = getRingColorIndex(index)
          return (
            <li key={bucket.bucketId} className="bucket-legend-item">
              <div className="bucket-legend-row">
                <details className={`bucket-detail bucket-color-${colorIndex} tone-${tone}`}>
                  <summary className="bucket-legend-summary">
                    <span className="bucket-legend-swatch" aria-hidden="true" />
                    <span className="bucket-legend-label">{bucket.label}</span>
                    <span className="remaining-caption">残り</span>
                    <span className="bucket-legend-value">{bucket.remainingPercent}%</span>
                    <Activity mode={bucket.reached ? 'visible' : 'hidden'}>
                      <span className="reached">上限到達</span>
                    </Activity>
                  </summary>
                  <dl className="bucket-meta">
                    <div>
                      <dt>使用済み</dt>
                      <dd>{bucket.usedPercent}%</dd>
                    </div>
                    <div>
                      <dt>リセット</dt>
                      <dd>
                        {formatJst(bucket.resetsAt)}
                        <span className="until-reset">
                          {formatUntilReset(bucket.resetsAt, now)}
                        </span>
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
                </details>
                <div className="bucket-order-actions" aria-label={`${bucket.label}の表示順を変更`}>
                  <button
                    className="bucket-order-button"
                    type="button"
                    onClick={() => {
                      onMove(bucket.bucketId, 'up')
                    }}
                    disabled={moveDisabled || index === 0}
                    aria-label={`${bucket.label}を1つ上へ`}
                    title="上へ"
                  >
                    ↑
                  </button>
                  <button
                    className="bucket-order-button"
                    type="button"
                    onClick={() => {
                      onMove(bucket.bucketId, 'down')
                    }}
                    disabled={moveDisabled || index === buckets.length - 1}
                    aria-label={`${bucket.label}を1つ下へ`}
                    title="下へ"
                  >
                    ↓
                  </button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
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
  const [bucketOrder, setBucketOrder] = useState(() => {
    return account.buckets.map((bucket) => bucket.bucketId)
  })
  const [bucketOrderSaveState, setBucketOrderSaveState] = useState<BucketOrderSaveState>('idle')
  const refreshController = useRef<AbortController | null>(null)
  const refreshing = refreshState === 'updating'
  const savingBucketOrder = bucketOrderSaveState === 'saving'
  const accountFreshness = getAccountFreshness(account)
  const orderedBuckets = orderBuckets(account.buckets, bucketOrder)

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

  async function moveBucket(bucketId: string, direction: BucketMoveDirection) {
    if (savingBucketOrder) return
    const previousOrder = orderedBuckets.map((bucket) => {
      return bucket.bucketId
    })
    const nextOrder = [...previousOrder]
    const currentIndex = nextOrder.indexOf(bucketId)
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= nextOrder.length) return

    const currentId = nextOrder[currentIndex]
    const targetId = nextOrder[targetIndex]
    if (currentId === undefined || targetId === undefined) return
    nextOrder[currentIndex] = targetId
    nextOrder[targetIndex] = currentId
    setBucketOrder(nextOrder)
    setBucketOrderSaveState('saving')
    const result = await saveBucketOrder(account.provider, account.accountAlias, nextOrder)
    if (result.ok) {
      setBucketOrderSaveState('idle')
      return
    }
    setBucketOrder(previousOrder)
    setBucketOrderSaveState('failed')
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
  const bucketOrderSaveMessage =
    bucketOrderSaveState === 'failed' ? '表示順を保存できませんでした' : undefined

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
          <Activity mode={bucketOrderSaveMessage ? 'visible' : 'hidden'}>
            <span className="refresh-status refresh-status-failed" role="status">
              {bucketOrderSaveMessage}
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
      <Activity mode={account.buckets.length > 0 ? 'visible' : 'hidden'}>
        <BucketRingOverview
          buckets={orderedBuckets}
          now={now}
          onMove={moveBucket}
          moveDisabled={savingBucketOrder}
        />
      </Activity>
    </section>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { StatusAccount, StatusBucket } from 'shared/src/contracts'
import { displayTone } from 'shared/src/remaining'
import { fetchRefreshStatus, requestRefresh } from '../lib/api-client'
import { formatAgo, formatJst, formatUntilReset } from '../lib/format'

const FRESHNESS_LABELS = {
  fresh: '最新',
  stale: 'stale',
  expired: '期限切れ'
} as const

const PROVIDER_LABELS = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok'
} as const

const REFRESH_POLL_INTERVAL_MS = 500
const REFRESH_POLL_TIMEOUT_MS = 5 * 60 * 1000

type RefreshState = 'idle' | 'updating' | 'failed' | 'offline' | 'timeout'

async function withRefreshDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadline: number,
  parentSignal?: AbortSignal
) {
  const controller = new AbortController()
  if (parentSignal?.aborted) {
    controller.abort()
    return { cancelled: true as const }
  }
  const timeoutMs = deadline - Date.now()
  if (timeoutMs <= 0) {
    controller.abort()
    return { timedOut: true as const }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ timedOut: true })
    }, timeoutMs)
  })
  let cancelListener: (() => void) | undefined
  const cancellation = parentSignal
    ? new Promise<{ cancelled: true }>((resolve) => {
        cancelListener = () => {
          controller.abort()
          resolve({ cancelled: true })
        }
        parentSignal.addEventListener('abort', cancelListener, { once: true })
      })
    : undefined
  try {
    const operationResult = operation(controller.signal).then((value) => {
      return { timedOut: false as const, value }
    })
    if (cancellation) {
      return await Promise.race([operationResult, timeout, cancellation])
    }
    return await Promise.race([operationResult, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    if (parentSignal && cancelListener) {
      parentSignal.removeEventListener('abort', cancelListener)
    }
    controller.abort()
  }
}

function waitForRefreshPoll(signal: AbortSignal, delayMs: number) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
        <span className={`freshness freshness-${bucket.freshness}`}>
          {FRESHNESS_LABELS[bucket.freshness]}
        </span>
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
  onRefresh
}: {
  account: StatusAccount
  now: Date
  onRefresh: () => void
}) {
  const [refreshState, setRefreshState] = useState<RefreshState>('idle')
  const refreshController = useRef<AbortController | null>(null)
  const refreshing = refreshState === 'updating'

  useEffect(() => {
    return () => {
      refreshController.current?.abort()
    }
  }, [])

  async function refresh() {
    if (refreshing) return
    setRefreshState('updating')
    const deadline = Date.now() + REFRESH_POLL_TIMEOUT_MS
    const controller = new AbortController()
    refreshController.current = controller
    const signal = controller.signal
    try {
      const resultWithDeadline = await withRefreshDeadline(
        (signal) => requestRefresh(account.provider, account.accountAlias, signal),
        deadline,
        signal
      )
      if ('cancelled' in resultWithDeadline || signal.aborted) return
      if (resultWithDeadline.timedOut) {
        setRefreshState('timeout')
        return
      }
      const result = resultWithDeadline.value
      if (signal.aborted) return
      if (!result.ok) {
        setRefreshState(result.status === 0 ? 'offline' : 'failed')
        return
      }
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now()
        const shouldPoll = await waitForRefreshPoll(
          signal,
          Math.min(REFRESH_POLL_INTERVAL_MS, remaining)
        )
        if (!shouldPoll || signal.aborted) return
        const statusWithDeadline = await withRefreshDeadline(
          (signal) => fetchRefreshStatus(result.body.requestId, signal),
          deadline,
          signal
        )
        if ('cancelled' in statusWithDeadline || signal.aborted) return
        if (statusWithDeadline.timedOut) {
          setRefreshState('timeout')
          return
        }
        const status = statusWithDeadline.value
        if (status === 'completed') {
          onRefresh()
          setRefreshState('idle')
          return
        }
        if (status === 'failed') {
          setRefreshState('failed')
          return
        }
      }
      if (signal.aborted) return
      setRefreshState('timeout')
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

  return (
    <section className="card">
      <header className="card-head">
        <h2 className={`provider provider-${account.provider}`}>
          {PROVIDER_LABELS[account.provider]}
        </h2>
        <span className="alias">{account.accountAlias}</span>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          aria-label={`${account.accountAlias}を更新`}
        >
          {refreshing ? 'Updating...' : '↻'}
        </button>
        {refreshMessage ? <span role="status">{refreshMessage}</span> : null}
      </header>
      <ul className="buckets">
        {account.buckets.map((bucket) => {
          return <BucketRow key={bucket.bucketId} bucket={bucket} now={now} />
        })}
      </ul>
    </section>
  )
}

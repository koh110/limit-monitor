import type { StatusAccount, StatusBucket } from 'shared/src/contracts'
import { displayTone } from 'shared/src/remaining'
import { formatAgo, formatJst, formatUntilReset } from '../_lib/format'

const FRESHNESS_LABELS = {
  fresh: '最新',
  stale: 'stale',
  expired: '期限切れ'
} as const

const PROVIDER_LABELS = {
  codex: 'Codex',
  claude: 'Claude'
} as const

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

export function AccountCard({ account, now }: { account: StatusAccount; now: Date }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2 className={`provider provider-${account.provider}`}>
          {PROVIDER_LABELS[account.provider]}
        </h2>
        <span className="alias">{account.accountAlias}</span>
      </header>
      <ul className="buckets">
        {account.buckets.map((bucket) => {
          return <BucketRow key={bucket.bucketId} bucket={bucket} now={now} />
        })}
      </ul>
    </section>
  )
}

// observedAt が Hub 時刻よりこの値以上未来の場合は拒否する(仕様 6.3)
export const OBSERVED_AT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

type LatestCandidate = {
  observedAt: string
  receivedAt: string
}

/**
 * 同じ provider + accountAlias + bucketId に複数端末から観測が届いた場合の
 * 最新値選択(仕様 6.3)。
 * - 新しい observedAt を採用する
 * - 古い観測値が遅れて到着しても上書きしない
 * - observedAt が同一時刻の場合は新しい receivedAt を採用する
 */
export function shouldReplaceLatest(existing: LatestCandidate, incoming: LatestCandidate): boolean {
  const existingObserved = Date.parse(existing.observedAt)
  const incomingObserved = Date.parse(incoming.observedAt)
  if (incomingObserved > existingObserved) {
    return true
  }
  if (incomingObserved < existingObserved) {
    return false
  }
  return Date.parse(incoming.receivedAt) > Date.parse(existing.receivedAt)
}

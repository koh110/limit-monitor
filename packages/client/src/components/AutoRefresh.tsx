import { useEffect } from 'react'

type Props = {
  intervalMs: number
  onRefresh: () => void
}

/**
 * 60 秒間隔とバックグラウンド復帰(visibilitychange)で onRefresh(loader revalidation)
 * を呼び出す。データ取得は呼び出し側(route loader)の責務で、ここはタイマーと
 * visibility という外部システムへの購読だけを行う。
 */
export function AutoRefresh({ intervalMs, onRefresh }: Props) {
  useEffect(() => {
    const timer = setInterval(() => {
      onRefresh()
    }, intervalMs)
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        onRefresh()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [intervalMs, onRefresh])

  return null
}

'use client'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

type Props = {
  intervalMs: number
}

/**
 * 60 秒間隔とバックグラウンド復帰(visibilitychange)で server component を
 * 再描画させる。データ取得は page(server)側の責務で、ここはタイマーと
 * visibility という外部システムへの購読だけを行う。
 */
export function AutoRefresh({ intervalMs }: Props) {
  const router = useRouter()

  useEffect(() => {
    const timer = setInterval(() => {
      router.refresh()
    }, intervalMs)
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        router.refresh()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [router, intervalMs])

  return null
}

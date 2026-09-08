/**
 * 非重複(cycle 重複なし)の実行ループ。
 *
 * setInterval では 1 cycle が interval より長くなると実行が重なり
 * 積み上がるため廃止する。本ループは必ず前 cycle 完了後に次の cycle を
 * schedule し、interval は「前 cycle 完了 → 次 cycle 開始」の間隔として
 * 計測する(実行が長引いても interval 間は最低保証される)。
 *
 * - oneshot(interval = 0)はループを使わないため intervalMs <= 0 はエラー
 * - runCycle の失敗はループを殺さない(失敗のログ出力は runCycle 側の責任)
 * - stop() 呼び出しは sleep 中の待ちを速やかに打ち切り、done が resolve する
 */
export function createCycleLoop({
  intervalMs,
  runCycle
}: {
  intervalMs: number
  runCycle: () => Promise<void>
}): { stop: () => void; done: Promise<void> } {
  if (intervalMs <= 0) {
    throw new Error('createCycleLoop requires a positive intervalMs (oneshot does not loop)')
  }
  let active = true
  const done = new Promise<void>((resolve) => {
    // stop() への応答を速やかにするため短周期ポーリングで sleep する
    const sleep = (ms: number) =>
      new Promise<void>((resolveSleep) => {
        const startedAt = Date.now()
        const timer = setInterval(() => {
          if (!active || Date.now() - startedAt >= ms) {
            clearInterval(timer)
            resolveSleep()
          }
        }, 250)
      })
    void (async () => {
      while (active) {
        await sleep(intervalMs)
        if (!active) {
          break
        }
        try {
          await runCycle()
        } catch {
          // 1 cycle の失敗でループを落とさない
        }
      }
      resolve()
    })()
  })
  return {
    stop: () => {
      active = false
    },
    done
  }
}

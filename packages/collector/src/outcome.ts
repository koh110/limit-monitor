import type { ProviderOutcome } from './collect.js'

/**
 * 起動直後 1 回目のサイクルの判定。
 *
 * real mode で取得に失敗した provider の値は送らないため Hub 側の古い値は
 * 消えないが、失敗を黙って成功扱いにはしない:
 *
 * - provider が 1 つも設定されていない → 設定不備として失敗
 * - 全 provider が失敗 → 失敗(oneshot なら非 0 終了、常駐なら起動させない)
 * - 一部失敗 + oneshot → その実行は不完全なので非 0 終了
 * - 一部失敗 + 常駐 → 一時障害の可能性があるため常駐は継続し、error ログを残す
 */
export function judgeStartupCycle({
  outcomes,
  isOneshot
}: {
  outcomes: readonly ProviderOutcome[]
  isOneshot: boolean
}): { exitCode: 0 | 1; continueRunning: boolean } {
  if (outcomes.length === 0) {
    return { exitCode: 1, continueRunning: false }
  }
  const failed = outcomes.filter((outcome) => {
    return !outcome.ok
  })
  if (failed.length === outcomes.length) {
    return { exitCode: 1, continueRunning: false }
  }
  if (failed.length > 0 && isOneshot) {
    return { exitCode: 1, continueRunning: false }
  }
  return { exitCode: 0, continueRunning: !isOneshot }
}

import type { ProviderOutcome } from './collect.js'

/**
 * one-shot Worker の収集サイクルを判定する。
 *
 * real mode で取得に失敗した provider の値は送らないため Hub 側の古い値は
 * 消えないが、失敗を黙って成功扱いにはしない。provider が 1 つもない場合と
 * 1 つでも失敗した場合は非 0 終了にする。
 */
export function judgeStartupCycle({ outcomes }: { outcomes: readonly ProviderOutcome[] }) {
  if (outcomes.length === 0) {
    return { exitCode: 1 as const }
  }
  const failed = outcomes.filter((outcome) => {
    return !outcome.ok
  })
  return { exitCode: failed.length === 0 ? (0 as const) : (1 as const) }
}

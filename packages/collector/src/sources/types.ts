import type { Observation } from 'shared/src/contracts'

/**
 * provider 1 件の取得結果。real mode では失敗を必ず失敗として返し、
 * fixture や既定値へ fallback しない(fake 値を Hub へ送らない)。
 */
export type ProviderReadResult =
  | { ok: true; observation: Observation }
  | { ok: false; reason: string; detail: string }

export type ProviderReadInput = {
  sourceId: string
  observedAt: string
}

export type ProviderReader = (input: ProviderReadInput) => Promise<ProviderReadResult>

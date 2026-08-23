import type { CodexRateLimitsPayload } from '../adapters/codex.js'

/**
 * Codex app-server `account/rateLimits/read` 応答の mock fixture(Phase 1)。
 * multi-bucket(rateLimitsByLimitId)を再現し、resetsAt は現在時刻から導出する。
 */
export function createCodexFixture(now: Date): CodexRateLimitsPayload {
  return {
    rateLimitsByLimitId: {
      codex_default: {
        limitId: 'codex_default',
        limitName: 'ChatGPT Plus',
        primary: {
          usedPercent: 28.5,
          windowDurationMins: 300,
          resetsAt: new Date(now.getTime() + (2 * 60 + 14) * 60 * 1000).toISOString()
        },
        secondary: {
          usedPercent: 61.2,
          windowDurationMins: 10080,
          resetsAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
        },
        rateLimitReachedType: null
      },
      codex_mini: {
        // secondary を持たない未知 bucket(仕様 16-11: 未知 bucket を欠落させない)
        limitId: 'codex_mini',
        limitName: 'Codex Mini',
        primary: {
          usedPercent: 5,
          windowDurationMins: 60,
          resetsAt: new Date(now.getTime() + 40 * 60 * 1000).toISOString()
        }
      }
    }
  }
}

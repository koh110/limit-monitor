import type { ClaudeStatusLineInput } from '../adapters/claude.js'

/**
 * Claude Code statusLine JSON の mock fixture(Phase 1)。
 * rate_limits 以外のフィールドは収集対象外のため含めない。
 */
export function createClaudeFixture(now: Date): ClaudeStatusLineInput {
  return {
    rate_limits: {
      five_hour: {
        used_percentage: 42,
        resets_at: new Date(now.getTime() + (1 * 60 + 30) * 60 * 1000).toISOString()
      },
      seven_day: {
        used_percentage: 12.5,
        resets_at: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
      }
    }
  }
}

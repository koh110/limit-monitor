import {
  buildClaudeUsageObservation,
  parseClaudeUsageEnvelope,
  parseClaudeUsageText
} from '../adapters/claude-usage.js'
import { runCommand } from '../lib/run-command.js'
import type { ProviderReadInput, ProviderReadResult } from './types.js'

export const CLAUDE_USAGE_ARGS = ['-p', '/usage', '--output-format', 'json'] as const

export type ClaudeSourceOptions = {
  command: string
  timeoutMs: number
  maxStdoutBytes: number
}

/**
 * `claude -p "/usage" --output-format json` を実行して実測の rate limit を得る。
 * transcript(`~/.claude/projects/**`)や認証情報(`~/.claude/.credentials.json`)は
 * 一切読まず、CLI の stdout だけを入力にする。
 */
export function createClaudeReader(options: ClaudeSourceOptions) {
  return async ({ sourceId, observedAt }: ProviderReadInput): Promise<ProviderReadResult> => {
    const command = await runCommand({
      command: options.command,
      args: CLAUDE_USAGE_ARGS,
      timeoutMs: options.timeoutMs,
      maxStdoutBytes: options.maxStdoutBytes
    })
    if (!command.ok) {
      return { ok: false, reason: command.reason, detail: command.detail }
    }

    const envelope = parseClaudeUsageEnvelope(command.stdout)
    if (!envelope.ok) {
      return { ok: false, reason: envelope.reason, detail: envelope.detail }
    }

    const limits = parseClaudeUsageText({ text: envelope.text, observedAt })
    const observation = buildClaudeUsageObservation({ limits, sourceId, observedAt })
    if (!observation) {
      return {
        ok: false,
        reason: 'no_rate_limits',
        // 取得できた行数だけを載せ、本文は載せない
        detail: 'claude usage output contained no rate limit lines'
      }
    }
    return { ok: true, observation }
  }
}

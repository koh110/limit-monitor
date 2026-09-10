import { open } from 'node:fs/promises'
import { buildGrokObservation, parseGrokBillingLine } from '../adapters/grok.js'
import type { ProviderReadInput, ProviderReadResult } from './types.js'

export type GrokSourceOptions = {
  logFile: string
  maxReadBytes: number
}

async function readRecentLog(file: string, maxReadBytes: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    const length = Math.min(stat.size, maxReadBytes)
    const offset = Math.max(0, stat.size - length)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, offset)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Grok Build がローカルの unified log に書いた最新 billing config を読む。
 * 認証ファイルは読まず、ログ末尾のみを有限サイズで走査する。
 */
export function createGrokReader(options: GrokSourceOptions) {
  return async ({ sourceId, observedAt }: ProviderReadInput): Promise<ProviderReadResult> => {
    let text: string
    try {
      text = await readRecentLog(options.logFile, options.maxReadBytes)
    } catch (error) {
      return {
        ok: false,
        reason: 'log_read_failed',
        detail: error instanceof Error ? error.message : 'failed to read grok log'
      }
    }

    const lines = text.split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const billing = parseGrokBillingLine(lines[index] ?? '')
      if (!billing) {
        continue
      }
      const observation = buildGrokObservation({ billing, sourceId, observedAt })
      if (!observation) {
        return {
          ok: false,
          reason: 'no_rate_limits',
          detail: 'grok billing entry contained no usable credit usage percentage'
        }
      }
      return { ok: true, observation }
    }

    return {
      ok: false,
      reason: 'no_billing_entry',
      detail: 'no recent Grok billing credits entry found in unified log'
    }
  }
}

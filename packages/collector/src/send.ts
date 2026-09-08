import type { IngestResult, Observation } from 'shared/src/contracts'
import { ingestResultSchema } from 'shared/src/contracts'
import type { Result } from 'shared/src/index'

/**
 * Hub への 1 件の observation 送信。
 *
 * fetch には finite timeout(AbortSignal.timeout)を必ず付与する。Hub が
 * 応答しなくなっても collector が吊るさず、timeout は明確な失敗
 * Outcome(非 0 の status を持たない failure)として返す。
 */
export async function sendObservation({
  hubUrl,
  token,
  observation,
  timeoutMs
}: {
  hubUrl: string
  token: string
  observation: Observation
  /** fetch の finite timeout(ミリ秒)。未指定で既定 30 秒 */
  timeoutMs?: number
}): Promise<Result<IngestResult>> {
  try {
    const res = await fetch(new URL('/api/v1/observations', hubUrl), {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs ?? 30_000),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(observation)
    })
    if (!res.ok) {
      return { ok: false, status: res.status, body: await res.text() }
    }
    const parsed = ingestResultSchema.safeParse(await res.json())
    if (!parsed.success) {
      return {
        ok: false,
        status: res.status,
        body: 'unexpected ingest response shape'
      }
    }
    return { ok: true, status: res.status, body: parsed.data }
  } catch (error) {
    return {
      ok: false,
      // 接続不能(Hub 停止)や timeout で応答がないため HTTP status を持たない場合は 0 とする
      status: 0,
      body: error instanceof Error ? error.message : 'network error'
    }
  }
}

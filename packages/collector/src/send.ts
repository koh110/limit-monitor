import type { IngestResult, Observation } from 'shared/src/contracts'
import { ingestResultSchema } from 'shared/src/contracts'
import type { Result } from 'shared/src/index'

export async function sendObservation({
  hubUrl,
  token,
  observation
}: {
  hubUrl: string
  token: string
  observation: Observation
}): Promise<Result<IngestResult>> {
  try {
    const res = await fetch(new URL('/api/v1/observations', hubUrl), {
      method: 'POST',
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
      // 接続不能(Hub 停止など)は HTTP status を持たないため 0 とする
      status: 0,
      body: error instanceof Error ? error.message : 'network error'
    }
  }
}

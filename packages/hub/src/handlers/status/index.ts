import type { Hono } from 'hono'
import { validator } from 'hono/validator'
import { providerSchema } from 'shared/src/contracts'
import type * as schema from 'shared/src/schema'
import { getStatus } from '../../features/status/get.js'
import type { Db } from '../../lib/database.js'
import { createHttpException } from '../../lib/wrap.js'

type GetStatusApi = schema.paths['/api/v1/status']['get']
type GetStatusByProviderApi = schema.paths['/api/v1/status/{provider}']['get']
type GetStatusByProviderResponse = GetStatusByProviderApi['responses']

export function createRoute(app: Hono, db: Db) {
  app.get('/api/v1/status' satisfies keyof schema.paths, async (c) => {
    const res = await getStatus({ db, now: new Date() })
    return c.json(res satisfies GetStatusApi['responses']['200']['content']['application/json'])
  })

  // Hono はパスパラメータを `:provider` で表すが TypeSpec/OpenAPI は `{provider}` のため
  // `satisfies keyof schema.paths` は使えない。型側の参照で契約と紐付ける
  app.get(
    '/api/v1/status/:provider',
    validator('param', (value): GetStatusByProviderApi['parameters']['path'] => {
      const parsed = providerSchema.safeParse(value.provider)
      if (!parsed.success) {
        throw createHttpException<
          GetStatusByProviderResponse['400']['content']['application/problem+json']
        >(400, {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'provider must be one of: codex, claude'
        })
      }
      return { provider: parsed.data }
    }),
    async (c) => {
      const { provider } = c.req.valid('param')
      const res = await getStatus({ db, now: new Date(), provider })
      return c.json(res satisfies GetStatusByProviderResponse['200']['content']['application/json'])
    }
  )
}

import type { Hono } from 'hono'
import { validator } from 'hono/validator'
import type { Provider, StatusResponse } from 'shared/src/contracts'
import { providerSchema } from 'shared/src/contracts'
import { getStatus } from '../../features/status/get.js'
import type { Db } from '../../lib/database.js'
import type { ProblemDetails } from '../../lib/wrap.js'
import { createHttpException } from '../../lib/wrap.js'

export function createRoute(app: Hono, db: Db) {
  app.get('/api/v1/status', async (c) => {
    const res = await getStatus({ db, now: new Date() })
    return c.json(res satisfies StatusResponse)
  })

  app.get(
    '/api/v1/status/:provider',
    validator('param', (value): { provider: Provider } => {
      const parsed = providerSchema.safeParse(value.provider)
      if (!parsed.success) {
        throw createHttpException<ProblemDetails>(400, {
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
      return c.json(res satisfies StatusResponse)
    }
  )
}

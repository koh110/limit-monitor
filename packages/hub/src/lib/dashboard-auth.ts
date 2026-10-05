import { timingSafeEqual } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import type * as schema from 'shared/src/schema'
import { createHttpException } from './wrap.js'

type UnauthorizedError = schema.components['schemas']['UnauthorizedError']

function sameSecret(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  )
}

/** Dashboard server が Hub に転送する書き込み API の共通認証 */
export function dashboardAuthMiddleware(expectedToken: string | null) {
  return createMiddleware(async (c, next) => {
    const authorization = c.req.header('Authorization') ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    if (!expectedToken || !sameSecret(token, expectedToken)) {
      throw createHttpException<UnauthorizedError>(401, {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'invalid or missing dashboard token'
      })
    }
    await next()
  })
}

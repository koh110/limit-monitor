import { randomUUID } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import { verifyToken } from '../features/tokens/store.js'
import type { Db } from './database.js'
import { logger } from './logger.js'
import type { RateLimiter } from './rate-limit.js'
import type { ProblemDetails } from './wrap.js'
import { createHttpException } from './wrap.js'

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string
    // collector token 認証済みの書き込み許可 sourceId / accountAlias
    tokenSourceId: string
    tokenAccountAlias: string
  }
}

export function accessLogMiddleware() {
  return createMiddleware(async (c, next) => {
    const requestId = randomUUID()
    c.set('requestId', requestId)
    const start = Date.now()
    await next()
    logger.log({
      label: 'access',
      body: `${c.req.method} ${c.req.path}`,
      meta: {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration: Date.now() - start
      }
    })
  })
}

function unauthorized() {
  return createHttpException<ProblemDetails>(401, {
    type: 'about:blank',
    title: 'Unauthorized',
    status: 401,
    detail: 'invalid or revoked collector token'
  })
}

export function collectorAuthMiddleware(db: Db) {
  return createMiddleware(async (c, next) => {
    const authorization = c.req.header('Authorization')
    if (!authorization) {
      throw unauthorized()
    }
    const [scheme, token] = authorization.split(' ')
    if (scheme !== 'Bearer' || !token) {
      throw unauthorized()
    }
    const verified = await verifyToken({ db, token })
    if (!verified) {
      logger.log({
        label: 'collector_auth',
        body: 'token verification failed',
        meta: { requestId: c.get('requestId') }
      })
      throw unauthorized()
    }
    c.set('tokenSourceId', verified.sourceId)
    c.set('tokenAccountAlias', verified.accountAlias)
    // next() は try の外で呼ぶ(下流の例外を 401 に変換しない)
    await next()
  })
}

export function ingestRateLimitMiddleware(limiter: RateLimiter) {
  return createMiddleware(async (c, next) => {
    const key = c.get('tokenSourceId')
    if (!limiter.check(key, Date.now())) {
      throw createHttpException<ProblemDetails>(429, {
        type: 'about:blank',
        title: 'Too Many Requests',
        status: 429,
        detail: 'ingest rate limit exceeded'
      })
    }
    await next()
  })
}

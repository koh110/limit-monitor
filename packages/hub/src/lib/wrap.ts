import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { logger } from './logger.js'

export type ProblemDetails = {
  type: string
  title: string
  status: number
  detail?: string
}

function isProblemDetails(value: unknown): value is ProblemDetails {
  return typeof value === 'object' && value !== null && 'title' in value && 'status' in value
}

export function createHttpException<T extends Record<string, unknown>>(
  status: NonNullable<ConstructorParameters<typeof HTTPException>[0]>,
  body: T
): HTTPException {
  return new HTTPException(status, {
    res: new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/problem+json' }
    })
  })
}

export async function handleError(error: Error, c: Context) {
  const requestId = c.get('requestId')
  if (error instanceof HTTPException) {
    logger.debug({
      label: 'handleError',
      body: error.message,
      meta: { requestId }
    })
    // res 付きの HTTPException(createHttpException 経由)はレスポンスの形状が
    // 確定しているためそのまま返す
    if (error.res) {
      return error.getResponse()
    }
    const problem = isProblemDetails(error.cause)
      ? error.cause
      : { type: 'about:blank', title: error.message, status: error.status }
    return c.json(problem, error.status)
  }
  logger.error({
    label: 'handleError',
    body: 'Error occurred in handleError',
    meta: { requestId },
    error
  })
  return c.json(
    {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500
    } satisfies ProblemDetails,
    500
  )
}

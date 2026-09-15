import type { StatusAccount } from 'shared/src/contracts'
import { fetchRefreshStatus, requestRefresh } from './api-client'

export const REFRESH_POLL_INTERVAL_MS = 500
export const REFRESH_POLL_TIMEOUT_MS = 5 * 60 * 1000

export type RefreshAccountResult = 'completed' | 'failed' | 'offline' | 'timeout'

async function withRefreshDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadline: number,
  parentSignal?: AbortSignal
) {
  const controller = new AbortController()
  if (parentSignal?.aborted) {
    controller.abort()
    return { cancelled: true as const }
  }
  const timeoutMs = deadline - Date.now()
  if (timeoutMs <= 0) {
    controller.abort()
    return { timedOut: true as const }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ timedOut: true })
    }, timeoutMs)
  })
  let cancelListener: (() => void) | undefined
  const cancellation = parentSignal
    ? new Promise<{ cancelled: true }>((resolve) => {
        cancelListener = () => {
          controller.abort()
          resolve({ cancelled: true })
        }
        parentSignal.addEventListener('abort', cancelListener, { once: true })
      })
    : undefined
  try {
    const operationResult = operation(controller.signal).then((value) => {
      return { timedOut: false as const, value }
    })
    if (cancellation) {
      return await Promise.race([operationResult, timeout, cancellation])
    }
    return await Promise.race([operationResult, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    if (parentSignal && cancelListener) {
      parentSignal.removeEventListener('abort', cancelListener)
    }
    controller.abort()
  }
}

function waitForRefreshPoll(signal: AbortSignal, delayMs: number) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function refreshAccount(
  account: Pick<StatusAccount, 'provider' | 'accountAlias'>,
  parentSignal?: AbortSignal,
  deadline = Date.now() + REFRESH_POLL_TIMEOUT_MS
): Promise<RefreshAccountResult> {
  try {
    const resultWithDeadline = await withRefreshDeadline(
      (signal) => requestRefresh(account.provider, account.accountAlias, signal),
      deadline,
      parentSignal
    )
    if ('cancelled' in resultWithDeadline || parentSignal?.aborted) return 'failed'
    if (resultWithDeadline.timedOut) return 'timeout'
    const result = resultWithDeadline.value
    if (!result.ok) return result.status === 0 ? 'offline' : 'failed'

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const shouldPoll = await waitForRefreshPoll(
        parentSignal ?? new AbortController().signal,
        Math.min(REFRESH_POLL_INTERVAL_MS, remaining)
      )
      if (!shouldPoll || parentSignal?.aborted) return 'failed'
      const statusWithDeadline = await withRefreshDeadline(
        (signal) => fetchRefreshStatus(result.body.requestId, signal),
        deadline,
        parentSignal
      )
      if ('cancelled' in statusWithDeadline || parentSignal?.aborted) return 'failed'
      if (statusWithDeadline.timedOut) return 'timeout'
      const status = statusWithDeadline.value
      if (status === 'completed') return 'completed'
      if (status === 'failed') return 'failed'
    }
    return 'timeout'
  } catch {
    return parentSignal?.aborted ? 'failed' : 'offline'
  }
}

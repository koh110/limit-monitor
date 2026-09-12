import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StatusAccount } from 'shared/src/contracts'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { AccountCard } from './AccountCard'

const { requestRefresh, fetchRefreshStatus } = vi.hoisted(() => {
  return {
    requestRefresh: vi.fn(),
    fetchRefreshStatus: vi.fn()
  }
})

vi.mock('../lib/api-client', () => {
  return { requestRefresh, fetchRefreshStatus }
})

const account: StatusAccount = {
  provider: 'codex',
  accountAlias: 'main',
  buckets: []
}

beforeEach(() => {
  vi.useFakeTimers()
  requestRefresh.mockResolvedValue({
    ok: true,
    body: { schemaVersion: 1, requestId: '00000000-0000-4000-8000-000000000001', status: 'queued' }
  })
  fetchRefreshStatus.mockResolvedValue('running')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

test('長時間のrefreshはHub offlineではなく明示的なtimeoutを表示する', async () => {
  render(
    <AccountCard account={account} now={new Date('2026-09-11T00:00:00.000Z')} onRefresh={vi.fn()} />
  )

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'mainを更新' }))
    await Promise.resolve()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
  })

  expect(screen.getByRole('status').textContent).toBe('Refresh timed out')
  expect(screen.queryByText('Hub offline')).toBeNull()
})

test('pending status fetch is interrupted by the wall-clock refresh timeout', async () => {
  fetchRefreshStatus.mockImplementation(() => {
    return new Promise(() => {})
  })
  render(
    <AccountCard account={account} now={new Date('2026-09-11T00:00:00.000Z')} onRefresh={vi.fn()} />
  )

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'mainを更新' }))
    await Promise.resolve()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
  })

  expect(screen.getByRole('status').textContent).toBe('Refresh timed out')
})

test('unmount 時に進行中のrefresh requestをabortする', async () => {
  let requestSignal: AbortSignal | undefined
  requestRefresh.mockImplementation((_provider, _accountAlias, signal) => {
    requestSignal = signal
    return new Promise(() => {})
  })
  const view = render(
    <AccountCard account={account} now={new Date('2026-09-11T00:00:00.000Z')} onRefresh={vi.fn()} />
  )

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'mainを更新' }))
    await Promise.resolve()
  })
  expect(requestSignal).toBeDefined()

  act(() => {
    view.unmount()
  })

  expect(requestSignal?.aborted).toBe(true)
})

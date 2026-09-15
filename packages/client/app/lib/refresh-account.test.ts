import type { StatusAccount } from 'shared/src/contracts'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { refreshAccount } from './refresh-account'

const { requestRefresh, fetchRefreshStatus } = vi.hoisted(() => {
  return {
    requestRefresh: vi.fn(),
    fetchRefreshStatus: vi.fn()
  }
})

vi.mock('./api-client', () => ({ requestRefresh, fetchRefreshStatus }))

const account: StatusAccount = {
  provider: 'codex',
  accountAlias: 'main',
  buckets: []
}

beforeEach(() => {
  vi.useFakeTimers()
  requestRefresh.mockReset()
  fetchRefreshStatus.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

test('refresh requestが失敗した場合はofflineを返す', async () => {
  requestRefresh.mockResolvedValue({ ok: false, status: 0 })

  await expect(refreshAccount(account)).resolves.toBe('offline')
  expect(fetchRefreshStatus).not.toHaveBeenCalled()
})

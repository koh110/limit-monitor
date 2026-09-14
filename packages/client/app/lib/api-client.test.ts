import { afterEach, expect, test, vi } from 'vite-plus/test'
import { fetchRefreshStatus } from './api-client'

const fetchMock = vi.spyOn(globalThis, 'fetch')

afterEach(() => {
  fetchMock.mockReset()
})

test('不正なrequestIdはHubへ送信せずnullを返す', async () => {
  await expect(fetchRefreshStatus('..')).resolves.toBeNull()
  expect(fetchMock).not.toHaveBeenCalled()
})

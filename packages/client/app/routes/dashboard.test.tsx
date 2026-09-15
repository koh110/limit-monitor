import type { StatusResponse } from 'shared/src/contracts'
import type { Result } from 'shared/src/index'
import { createRoutesStub } from 'react-router'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import App, { HydrateFallback } from '../root'
import Dashboard, { clientLoader } from './dashboard'

// Hub へは接続しない。clientLoader -> fetchStatus の配線だけを見たいので
// api-client だけを差し替える。
const { fetchStatus, refreshAccount } = vi.hoisted(() => {
  return {
    fetchStatus: vi.fn<() => Promise<Result<StatusResponse>>>(),
    refreshAccount: vi.fn()
  }
})
vi.mock('../lib/api-client', () => {
  return { fetchStatus }
})
vi.mock('../lib/refresh-account', () => ({ refreshAccount }))

const online: Result<StatusResponse> = {
  ok: true,
  status: 200,
  body: { schemaVersion: 1, generatedAt: '2026-08-23T04:00:00.000Z', accounts: [] }
}

const offline: Result<StatusResponse> = { ok: false, status: 0, body: 'hub unreachable' }
const onlineWithAccounts: Result<StatusResponse> = {
  ok: true,
  status: 200,
  body: {
    schemaVersion: 1,
    generatedAt: '2026-08-23T04:00:00.000Z',
    accounts: [
      { provider: 'codex', accountAlias: 'main', buckets: [] },
      { provider: 'claude', accountAlias: 'work', buckets: [] }
    ]
  }
}

beforeEach(() => {
  fetchStatus.mockReset()
  refreshAccount.mockReset()
  refreshAccount.mockResolvedValue('completed')
})

afterEach(() => {
  cleanup()
})

function renderDashboard() {
  const Stub = createRoutesStub([
    {
      path: '/',
      Component: App,
      HydrateFallback,
      children: [{ index: true, loader: () => clientLoader(), Component: Dashboard }]
    }
  ])
  return render(<Stub />)
}

test('clientLoader は fetchStatus の結果をそのまま返す', async () => {
  fetchStatus.mockResolvedValue(online)

  await expect(clientLoader()).resolves.toBe(online)
  expect(fetchStatus).toHaveBeenCalledTimes(1)
})

test('index route は clientLoader の結果を loaderData として受け取る', async () => {
  fetchStatus.mockResolvedValue(online)

  renderDashboard()

  expect(await screen.findByText(/Hub 接続中/)).toBeTruthy()
  expect(screen.getByText(/まだ有効な観測値がありません/)).toBeTruthy()
})

test('Hub へ到達できない場合は OFFLINE 表示へ落ちる', async () => {
  fetchStatus.mockResolvedValue(offline)

  renderDashboard()

  expect(await screen.findByText('Hub OFFLINE')).toBeTruthy()
  expect(screen.getByText('Limit Hub へ接続できません')).toBeTruthy()
})

test('すべてのデータを更新するボタンは表示中の各サービスを更新する', async () => {
  fetchStatus.mockResolvedValue(onlineWithAccounts)

  renderDashboard()

  const button = await screen.findByRole('button', { name: 'すべてのデータを更新' })
  fireEvent.click(button)
  await vi.waitFor(() => expect(refreshAccount).toHaveBeenCalledTimes(2))
  expect(refreshAccount.mock.calls.map(([account]) => account.accountAlias)).toEqual([
    'main',
    'work'
  ])
})

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MAX_BUCKETS_PER_OBSERVATION, type StatusAccount } from 'shared/src/contracts'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { AccountCard } from './AccountCard'

const { requestRefresh, fetchRefreshStatus, saveBucketOrder } = vi.hoisted(() => {
  return {
    requestRefresh: vi.fn(),
    fetchRefreshStatus: vi.fn(),
    saveBucketOrder: vi.fn()
  }
})

vi.mock('../lib/api-client', () => {
  return { requestRefresh, fetchRefreshStatus, saveBucketOrder }
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
  saveBucketOrder.mockResolvedValue({
    ok: true,
    body: {
      schemaVersion: 1,
      provider: 'codex',
      accountAlias: 'main',
      bucketOrder: ['codex:primary', 'codex:secondary']
    }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

test('鮮度badgeはカード単位で最も古いbucketの状態を表示する', () => {
  const accountWithMixedFreshness: StatusAccount = {
    ...account,
    buckets: [
      {
        bucketId: 'codex:primary',
        label: 'Primary',
        usedPercent: 20,
        remainingPercent: 80,
        windowDurationSeconds: 3600,
        resetsAt: '2026-09-11T01:00:00.000Z',
        observedAt: '2026-09-11T00:00:00.000Z',
        reached: false,
        freshness: 'fresh'
      },
      {
        bucketId: 'codex:secondary',
        label: 'Secondary',
        usedPercent: 80,
        remainingPercent: 20,
        windowDurationSeconds: 86400,
        resetsAt: '2026-09-12T00:00:00.000Z',
        observedAt: '2026-09-10T00:00:00.000Z',
        reached: false,
        freshness: 'stale'
      }
    ]
  }

  render(
    <AccountCard
      account={accountWithMixedFreshness}
      now={new Date('2026-09-11T00:00:00.000Z')}
      onRefresh={vi.fn()}
    />
  )

  const freshnessBadge = screen.getByText('stale')
  expect(freshnessBadge.classList.contains('freshness')).toBe(true)
  expect(freshnessBadge.classList.contains('freshness-stale')).toBe(true)
  expect(screen.getAllByText('stale')).toHaveLength(1)
  expect(screen.queryByText('最新')).toBeNull()
})

test('bucketが空のカードには鮮度badgeを表示しない', () => {
  const view = render(
    <AccountCard account={account} now={new Date('2026-09-11T00:00:00.000Z')} onRefresh={vi.fn()} />
  )

  expect(view.container.querySelector('.freshness')).toBeNull()
})

test('同じアカウントのbucketを同心円リングとして重ねて表示する', () => {
  const accountWithBuckets: StatusAccount = {
    ...account,
    buckets: [
      {
        bucketId: 'codex:primary',
        label: 'Primary',
        usedPercent: 20,
        remainingPercent: 80,
        windowDurationSeconds: 3600,
        resetsAt: '2026-09-11T01:00:00.000Z',
        observedAt: '2026-09-11T00:00:00.000Z',
        reached: false,
        freshness: 'fresh'
      },
      {
        bucketId: 'codex:secondary',
        label: 'Secondary',
        usedPercent: 80,
        remainingPercent: 20,
        windowDurationSeconds: 86400,
        resetsAt: '2026-09-12T00:00:00.000Z',
        observedAt: '2026-09-10T00:00:00.000Z',
        reached: false,
        freshness: 'stale'
      }
    ]
  }

  const view = render(
    <AccountCard
      account={accountWithBuckets}
      now={new Date('2026-09-11T00:00:00.000Z')}
      onRefresh={vi.fn()}
    />
  )

  expect(screen.getAllByRole('meter')).toHaveLength(2)
  const primaryMeter = screen.getByRole('meter', { name: 'Primary 残量' })
  const secondaryMeter = screen.getByRole('meter', { name: 'Secondary 残量' })
  expect(primaryMeter.getAttribute('aria-valuenow')).toBe('80')
  expect(secondaryMeter.getAttribute('aria-valuenow')).toBe('20')
  expect(primaryMeter.classList.contains('tone-green')).toBe(true)
  expect(secondaryMeter.classList.contains('tone-gray')).toBe(true)
  expect(primaryMeter.classList.contains('bucket-color-0')).toBe(true)
  expect(secondaryMeter.classList.contains('bucket-color-1')).toBe(true)
  expect(screen.getAllByText('残り')).toHaveLength(2)
  expect(view.container.querySelectorAll('.bucket-ring-progress')).toHaveLength(2)
  expect(view.container.querySelectorAll('.bucket-detail[open]')).toHaveLength(0)

  fireEvent.click(screen.getByText('Primary'))
  expect(view.container.querySelectorAll('.bucket-detail[open]')).toHaveLength(1)
  expect(view.container.querySelector('.bucket-detail[open] .bucket-meta')).not.toBeNull()
  expect(view.container.querySelector('.meter')).toBeNull()
})

test('契約上の最大bucket数でもリング色を重複させない', () => {
  const buckets: StatusAccount['buckets'] = []
  for (let index = 0; index < MAX_BUCKETS_PER_OBSERVATION; index += 1) {
    buckets.push({
      bucketId: `codex:bucket-${index}`,
      label: `Bucket ${index}`,
      usedPercent: index,
      remainingPercent: 100 - index,
      windowDurationSeconds: 3600,
      resetsAt: '2026-09-11T01:00:00.000Z',
      observedAt: '2026-09-11T00:00:00.000Z',
      reached: false,
      freshness: 'fresh'
    })
  }

  render(
    <AccountCard
      account={{ ...account, buckets }}
      now={new Date('2026-09-11T00:00:00.000Z')}
      onRefresh={vi.fn()}
    />
  )

  const meters = screen.getAllByRole('meter')
  expect(meters).toHaveLength(MAX_BUCKETS_PER_OBSERVATION)
  for (let index = 0; index < MAX_BUCKETS_PER_OBSERVATION; index += 1) {
    expect(meters[index]?.classList.contains(`bucket-color-${index}`)).toBe(true)
  }
})

test('凡例の上下ボタンでbucketの表示順とリング順を変更し、SQLite保存 API を呼ぶ', async () => {
  const accountWithBuckets: StatusAccount = {
    ...account,
    buckets: [
      {
        bucketId: 'codex:primary',
        label: 'Primary',
        usedPercent: 20,
        remainingPercent: 80,
        windowDurationSeconds: 3600,
        resetsAt: '2026-09-11T01:00:00.000Z',
        observedAt: '2026-09-11T00:00:00.000Z',
        reached: false,
        freshness: 'fresh'
      },
      {
        bucketId: 'codex:secondary',
        label: 'Secondary',
        usedPercent: 80,
        remainingPercent: 20,
        windowDurationSeconds: 86400,
        resetsAt: '2026-09-12T00:00:00.000Z',
        observedAt: '2026-09-10T00:00:00.000Z',
        reached: false,
        freshness: 'stale'
      }
    ]
  }

  render(
    <AccountCard
      account={accountWithBuckets}
      now={new Date('2026-09-11T00:00:00.000Z')}
      onRefresh={vi.fn()}
    />
  )

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Secondaryを1つ上へ' }))
    await Promise.resolve()
  })

  expect(screen.getAllByRole('meter')[0]?.getAttribute('aria-label')).toBe('Secondary 残量')
  expect(screen.getAllByRole('meter')[1]?.getAttribute('aria-label')).toBe('Primary 残量')
  expect(screen.getByRole('button', { name: 'Secondaryを1つ下へ' }).hasAttribute('disabled')).toBe(
    false
  )
  expect(screen.getByRole('button', { name: 'Primaryを1つ上へ' }).hasAttribute('disabled')).toBe(
    false
  )
  expect(saveBucketOrder).toHaveBeenCalledWith('codex', 'main', [
    'codex:secondary',
    'codex:primary'
  ])
})

test('refresh button remains a compact icon control while updating', async () => {
  requestRefresh.mockImplementation(() => new Promise(() => {}))
  render(
    <AccountCard account={account} now={new Date('2026-09-11T00:00:00.000Z')} onRefresh={vi.fn()} />
  )

  const button = screen.getByRole('button', { name: 'mainを更新' })
  expect(button.classList.contains('refresh-button')).toBe(true)
  expect(button.querySelector('svg.refresh-icon')).not.toBeNull()

  await act(async () => {
    fireEvent.click(button)
    await Promise.resolve()
  })

  expect(button.hasAttribute('disabled')).toBe(true)
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(button.getAttribute('title')).toBe('更新中')
  expect(button.querySelector('svg.refresh-icon-spinning')).not.toBeNull()
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

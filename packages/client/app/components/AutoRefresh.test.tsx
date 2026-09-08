import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { AutoRefresh } from './AutoRefresh'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
}

test('intervalMs ごとに onRefresh を呼ぶ', () => {
  const onRefresh = vi.fn()
  render(<AutoRefresh intervalMs={60_000} onRefresh={onRefresh} />)

  expect(onRefresh).not.toHaveBeenCalled()
  vi.advanceTimersByTime(60_000)
  expect(onRefresh).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(60_000)
  expect(onRefresh).toHaveBeenCalledTimes(2)
})

test('バックグラウンドから復帰(visibilitychange)した時に onRefresh を呼ぶ', () => {
  const onRefresh = vi.fn()
  render(<AutoRefresh intervalMs={60_000} onRefresh={onRefresh} />)

  setVisibility('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(onRefresh).not.toHaveBeenCalled()

  setVisibility('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(onRefresh).toHaveBeenCalledTimes(1)
})

test('unmount 後は timer / listener を解除する', () => {
  const onRefresh = vi.fn()
  const { unmount } = render(<AutoRefresh intervalMs={60_000} onRefresh={onRefresh} />)
  unmount()

  vi.advanceTimersByTime(60_000)
  setVisibility('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(onRefresh).not.toHaveBeenCalled()
})

import { expect, test } from 'vite-plus/test'
import { createControlRegistry, createPeriodicScheduler } from './features/control.js'

test('hub scheduler emits provider-independent collect triggers', async () => {
  const messages: { type: string }[] = []
  const scheduler = createPeriodicScheduler({
    intervalMs: 5,
    dispatch: (message) => {
      messages.push(message)
    }
  })
  scheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 25))
  scheduler.stop()

  expect(messages.length).toBeGreaterThan(0)
  expect(messages.every((message) => message.type === 'collect')).toBe(true)
})

test('control registry scopes sessions by source and account', () => {
  const registry = createControlRegistry()
  const first = registry.register({ sourceId: 'source-a', accountAlias: 'main', send: () => true })
  const second = registry.register({ sourceId: 'source-b', accountAlias: 'main', send: () => true })

  expect(registry.find('source-a', 'main')).toBeDefined()
  expect(registry.find('source-b', 'main')).toBeDefined()
  expect(registry.find('source-a', 'other')).toBeUndefined()

  first()
  expect(registry.find('source-a', 'main')).toBeUndefined()
  expect(registry.find('source-b', 'main')).toBeDefined()
  second()
})

test('stale session cleanup does not remove a replacement session', () => {
  const registry = createControlRegistry()
  const first = registry.register({ sourceId: 'source-a', accountAlias: 'main', send: () => true })
  const replacement = registry.register({
    sourceId: 'source-a',
    accountAlias: 'main',
    send: () => true
  })

  first()
  expect(registry.find('source-a', 'main')).toBeDefined()
  replacement()
  expect(registry.find('source-a', 'main')).toBeUndefined()
})

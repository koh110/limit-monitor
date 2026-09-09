import { expect, test } from 'vite-plus/test'
import { createTestDb } from '../../../test/util.js'
import { issueToken, listTokens, revokeToken, verifyToken } from './store.js'

const now = new Date('2026-08-23T04:00:00.000Z')

test('発行した token で検証でき、sourceId と accountAlias が返る', async () => {
  const { db, cleanup } = createTestDb()
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'main', now })
  expect(issued.token.startsWith('lmt_')).toBe(true)

  const verified = await verifyToken({ db, token: issued.token })
  expect(verified).toEqual({ sourceId: 'dev-machine', accountAlias: 'main' })
  cleanup()
})

test('同一 sourceId で複数の accountAlias の token を発行・検証できる', async () => {
  const { db, cleanup } = createTestDb()
  const main = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'main', now })
  const sub = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'sub', now })

  expect(await verifyToken({ db, token: main.token })).toEqual({
    sourceId: 'dev-machine',
    accountAlias: 'main'
  })
  expect(await verifyToken({ db, token: sub.token })).toEqual({
    sourceId: 'dev-machine',
    accountAlias: 'sub'
  })
  cleanup()
})

test('未登録 token は検証に失敗する', async () => {
  const { db, cleanup } = createTestDb()
  const verified = await verifyToken({ db, token: 'lmt_unknown-token' })
  expect(verified).toBe(null)
  cleanup()
})

test('失効した token は検証に失敗する', async () => {
  const { db, cleanup } = createTestDb()
  const issued = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'main', now })
  const revoked = await revokeToken({ db, sourceId: 'dev-machine', accountAlias: 'main', now })
  expect(revoked).toBe(true)
  const verified = await verifyToken({ db, token: issued.token })
  expect(verified).toBe(null)
  cleanup()
})

test('失効は sourceId + accountAlias の組にだけ効き、他 alias の token は有効なまま', async () => {
  const { db, cleanup } = createTestDb()
  const main = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'main', now })
  const sub = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'sub', now })
  await revokeToken({ db, sourceId: 'dev-machine', accountAlias: 'main', now })

  expect(await verifyToken({ db, token: main.token })).toBe(null)
  expect(await verifyToken({ db, token: sub.token })).toEqual({
    sourceId: 'dev-machine',
    accountAlias: 'sub'
  })
  cleanup()
})

test('存在しない sourceId + accountAlias の失効は false を返す', async () => {
  const { db, cleanup } = createTestDb()
  const revoked = await revokeToken({ db, sourceId: 'nobody', accountAlias: 'main', now })
  expect(revoked).toBe(false)
  cleanup()
})

test('再発行すると旧 token は無効になり revoked 状態も解除される', async () => {
  const { db, cleanup } = createTestDb()
  const first = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'main', now })
  await revokeToken({ db, sourceId: 'dev-machine', accountAlias: 'main', now })
  const second = await issueToken({ db, sourceId: 'dev-machine', accountAlias: 'main', now })

  expect(await verifyToken({ db, token: first.token })).toBe(null)
  expect(await verifyToken({ db, token: second.token })).toEqual({
    sourceId: 'dev-machine',
    accountAlias: 'main'
  })
  cleanup()
})

test('一覧は hash を含まず、accountAlias と状態を返す', async () => {
  const { db, cleanup } = createTestDb()
  await issueToken({ db, sourceId: 'machine-a', accountAlias: 'main', now })
  await issueToken({ db, sourceId: 'machine-b', accountAlias: 'sub', now })
  await issueToken({ db, sourceId: 'machine-b', accountAlias: 'main', now })
  await revokeToken({ db, sourceId: 'machine-b', accountAlias: 'sub', now })

  const tokens = await listTokens({ db })
  expect(tokens).toEqual([
    {
      sourceId: 'machine-a',
      accountAlias: 'main',
      createdAt: now.toISOString(),
      revokedAt: null
    },
    {
      sourceId: 'machine-b',
      accountAlias: 'main',
      createdAt: now.toISOString(),
      revokedAt: null
    },
    {
      sourceId: 'machine-b',
      accountAlias: 'sub',
      createdAt: now.toISOString(),
      revokedAt: now.toISOString()
    }
  ])
  cleanup()
})

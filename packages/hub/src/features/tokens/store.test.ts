import { expect, test } from 'vite-plus/test'
import { createTestDb } from '../../../test/util.js'
import { issueToken, listTokens, revokeToken, verifyToken } from './store.js'

const now = new Date('2026-08-23T04:00:00.000Z')

test('発行した token で検証でき、sourceId が返る', async () => {
  const { db, cleanup } = createTestDb()
  const issued = await issueToken({ db, sourceId: 'dev-machine', now })
  expect(issued.token.startsWith('lmt_')).toBe(true)

  const verified = await verifyToken({ db, token: issued.token })
  expect(verified).toEqual({ sourceId: 'dev-machine' })
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
  const issued = await issueToken({ db, sourceId: 'dev-machine', now })
  const revoked = await revokeToken({ db, sourceId: 'dev-machine', now })
  expect(revoked).toBe(true)
  const verified = await verifyToken({ db, token: issued.token })
  expect(verified).toBe(null)
  cleanup()
})

test('存在しない sourceId の失効は false を返す', async () => {
  const { db, cleanup } = createTestDb()
  const revoked = await revokeToken({ db, sourceId: 'nobody', now })
  expect(revoked).toBe(false)
  cleanup()
})

test('再発行すると旧 token は無効になり revoked 状態も解除される', async () => {
  const { db, cleanup } = createTestDb()
  const first = await issueToken({ db, sourceId: 'dev-machine', now })
  await revokeToken({ db, sourceId: 'dev-machine', now })
  const second = await issueToken({ db, sourceId: 'dev-machine', now })

  expect(await verifyToken({ db, token: first.token })).toBe(null)
  expect(await verifyToken({ db, token: second.token })).toEqual({
    sourceId: 'dev-machine'
  })
  cleanup()
})

test('一覧は hash を含まず、状態を返す', async () => {
  const { db, cleanup } = createTestDb()
  await issueToken({ db, sourceId: 'machine-a', now })
  await issueToken({ db, sourceId: 'machine-b', now })
  await revokeToken({ db, sourceId: 'machine-b', now })

  const tokens = await listTokens({ db })
  expect(tokens).toEqual([
    {
      sourceId: 'machine-a',
      createdAt: now.toISOString(),
      revokedAt: null
    },
    {
      sourceId: 'machine-b',
      createdAt: now.toISOString(),
      revokedAt: now.toISOString()
    }
  ])
  cleanup()
})

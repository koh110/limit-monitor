import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, migrateDb } from '../src/lib/database.js'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

/**
 * テストごとに一時ファイルの SQLite を作成して分離する。
 * worker/テスト間で DB を共有しないため、並列実行に耐える。
 */
export function createTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-hub-test-'))
  const db = createDb(path.join(dir, 'test.sqlite'))
  migrateDb(db, migrationsFolder)
  return {
    db,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

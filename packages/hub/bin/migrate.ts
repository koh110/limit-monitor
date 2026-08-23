#!/usr/bin/env node
/**
 * drizzle-kit generate で生成した migration を DB_FILE_PATH へ適用する。
 * 実行前に `npm run build -w hub` が必要(predb-migrate で自動実行される)。
 */
import path from 'node:path'
import { DB_FILE_PATH } from '../dist/src/config.js'
import { createDb, migrateDb } from '../dist/src/lib/database.js'

function main() {
  const migrationsFolder = path.resolve(import.meta.dirname, '../drizzle')
  const db = createDb(DB_FILE_PATH)
  migrateDb(db, migrationsFolder)
  console.log(`migrated: ${DB_FILE_PATH}`)
}

main()

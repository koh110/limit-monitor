import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'

export function createDb(filePath: string) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  }
  const client = new DatabaseSync(filePath)
  client.exec('PRAGMA journal_mode = WAL')
  client.exec('PRAGMA foreign_keys = ON')
  return drizzle({ client })
}

export type Db = ReturnType<typeof createDb>

export function migrateDb(db: Db, migrationsFolder: string) {
  migrate(db, { migrationsFolder })
}

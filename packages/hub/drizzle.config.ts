import { defineConfig } from 'drizzle-kit'

// schema は shared パッケージを単一ソースとする。
// migration の適用は Hub 起動時(src/index.ts)と `npm run db-migrate` が行う。
// `drizzle-kit push` はローカル検証用途に限定し、運用では generate した SQL を適用する
export default defineConfig({
  dialect: 'sqlite',
  schema: '../shared/src/db/schema.ts',
  out: './drizzle'
})

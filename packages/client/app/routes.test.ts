import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vite-plus/test'
import routes from './routes'

const appDir = path.dirname(fileURLToPath(import.meta.url))

test('routes は dashboard を index route として配線する', () => {
  expect(routes).toEqual([{ file: 'routes/dashboard.tsx', index: true }])
})

test('Framework Mode が要求する entry / root / route module が app 配下に存在する', () => {
  // routes.ts と規約 entry は build 時にしか解決されないため、
  // 参照先の消失(rename / 移動)を unit test で検出する。
  const required = [
    'root.tsx',
    'entry.client.tsx',
    'entry.server.tsx',
    ...routes.map((route) => {
      return route.file
    })
  ]
  for (const file of required) {
    expect(fs.existsSync(path.join(appDir, file))).toBe(true)
  }
})

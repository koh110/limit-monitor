import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    ignorePatterns: ['**/dist/**', '**/.next/**', '**/drizzle/**'],
    singleQuote: true,
    semi: false,
    trailingComma: 'none'
  },
  lint: {
    ignorePatterns: ['**/dist/**', '**/.next/**'],
    overrides: [
      {
        files: ['**/*.test.ts'],
        rules: {
          // 並列耐性テストの規約として describe() を禁止する。
          // 一時的な reminder ではなく恒久的なコーディング規約のため error にする。
          'no-restricted-imports': [
            'error',
            {
              paths: [
                {
                  name: 'vite-plus/test',
                  importNames: ['describe'],
                  message:
                    'describe() は並列耐性テストの規約に反します。フラットな test() を使ってください。'
                }
              ]
            }
          ]
        }
      }
    ]
  }
})

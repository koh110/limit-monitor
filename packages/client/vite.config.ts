import { reactRouter } from '@react-router/dev/vite'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vite-plus'

// React Router の Vite plugin は route module を Framework Mode の entry として
// 変換するため dev / build では必須だが、test では module runner 経由の import に
// react-refresh preamble を要求して落ちる。test だけ素の React plugin へ差し替え、
// component / route module を単体で import できるようにする。
// (defineConfig の関数形式は vite-plus の型で解決できないため env 変数で分ける)
const isTest = process.env.VITEST === 'true'

export default defineConfig({
  plugins: isTest ? react() : reactRouter(),
  test: {
    environment: 'happy-dom',
    exclude: [...configDefaults.exclude, '**/dist/**']
  }
})

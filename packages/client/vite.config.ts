import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vite-plus'

export default defineConfig({
  plugins: [react()],
  build: {
    // 静的 asset は dist/public、配信 server は dist/server(tsconfig.server.json)。
    // server の JS を配信 root へ露出させないため分ける。
    outDir: 'dist/public'
  },
  test: {
    environment: 'happy-dom',
    exclude: [...configDefaults.exclude, '**/dist/**']
  }
})

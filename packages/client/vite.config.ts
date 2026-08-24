import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vite-plus'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    exclude: [...configDefaults.exclude, '**/dist/**']
  }
})

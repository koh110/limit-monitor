import path from 'node:path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  experimental: {
    // Dashboard は常に最新の status を表示するため client router cache を無効化する
    staleTimes: {
      dynamic: 0
    }
  },
  turbopack: {
    root: path.resolve(import.meta.dirname, '../../')
  }
}

export default nextConfig

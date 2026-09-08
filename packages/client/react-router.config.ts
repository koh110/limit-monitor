import type { Config } from '@react-router/dev/config'

export default {
  // データ取得はブラウザから Hub へ直接 fetch するため server render は行わない。
  // index.html は root route の prerender として build 時に生成される。
  ssr: false,
  // 出力先は <buildDirectory>/client(と ssr: false で破棄される server)固定。
  // 配信 root は dist/public、配信 server は dist/server(tsconfig.server.json)
  // なので、衝突しない dist/spa へ出して build script で dist/public へ移す。
  buildDirectory: 'dist/spa',
  future: {
    // build を Vite の Environment API に乗せる(vp build の builder 経路で
    // client / ssr の出力先を正しく分けるために必須)
    v8_viteEnvironmentApi: true
  }
} satisfies Config

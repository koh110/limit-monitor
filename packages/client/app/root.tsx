import { Links, Meta, Outlet, Scripts } from 'react-router'
import type { Route } from './+types/root'
import './styles.css'

export const meta: Route.MetaFunction = () => {
  return [
    { title: 'Limit Monitor' },
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ]
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="UTF-8" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

/**
 * ssr: false のため index.html は「clientLoader 実行前の状態」で prerender される。
 * ここを定義しないと React Router が開発者向け console.log を出すだけの既定
 * fallback を本番 index.html へ埋め込むため、必ず自前の初期表示を持たせる。
 *
 * 表示は dashboard の空状態(.empty)と同じ枠に揃え、Hub 応答までの間に
 * レイアウトが飛ばないようにする。
 */
export function HydrateFallback() {
  return (
    <main className="dashboard">
      <header className="dashboard-head">
        <h1>Limit Monitor</h1>
        <p className="hub-state hub-pending">Hub 問い合わせ中</p>
      </header>
      <section className="empty" aria-busy="true">
        <p className="empty-value">--</p>
        <p>観測値を読み込んでいます</p>
      </section>
    </main>
  )
}

export default function App() {
  return <Outlet />
}

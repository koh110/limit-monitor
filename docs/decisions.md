# Decisions

仕様書 18 章(TBD)および実装中の決定事項の記録。

## 確定事項

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 実装対象リポジトリ | `limit-monitor`(本リポジトリ、新規) | 専用リポジトリとして独立させる |
| ライセンス | MIT | 個人 OSS の標準 |
| Hub の配置 | 自宅 Linux 開発機 | 既存サーバーを流用し LAN 直結を優先 |
| Hub listen port | `8787` | 仕様書の推奨例に従う |
| 常駐方式 | systemd 主運用 | Docker Compose より単純で、Node 単体で完結する |
| Web framework | Hono + `@hono/node-server` | service-template 準拠 |
| Dashboard | Vite + React + react-router data-loader + 直接 CORS fetch | service-template 準拠 |
| monorepo | npm workspaces(`packages/*`) | service-template 準拠 |
| ツールチェーン | TypeScript + vite-plus(`vp test` / `vp fmt` / `vp lint`) | Vitest/Prettier を直接実行しない |
| DB | SQLite | 個人利用の最新値保存に十分 |
| ORM | Drizzle ORM + `drizzle-orm/node-sqlite`(driver: Node `node:sqlite`) | 追加 native 依存なし。**Prisma は採用しない(禁止)** |
| migration | `drizzle-kit generate` + 起動時/`db-migrate` での適用。`push` は検証用途のみ | 生成 SQL をリポジトリ管理する |
| 複数アカウント | `accountAlias` を payload / DB / API / UI の全レイヤーで扱う | 同一 provider 複数アカウントに対応 |
| 履歴保存 | MVP では保存しない(`latest_limits` と `collector_tokens` のみ) | 仕様 8.2。必要になった時点で snapshot 方式を追加 |
| Ingest 認証 | Collector ごとの Bearer token(SHA-256 hash 保存、revoke/reissue 可) | 仕様 7.2 |
| Node.js | 24.x | `node:sqlite` と strip-types を利用 |
| Collector(Phase 1) | Linux 上で Codex/Claude fixture を送信する mock | 仕様 15 Phase 1(mock observation 送信) |

## 未確定(Phase 2 以降で決定)

- 自宅サーバーの固定 private IP / DHCP 予約
- 実際に Codex/Claude を利用しているホスト一覧と各 OS
- 既存 Claude statusLine 設定の有無(上書きせず chain 方式で共存させる)
- 既存 Cloudflare Tunnel 名と private routing の有効化状況
- iPhone の Zero Trust enrollment 状況、WARP Split Tunnel mode
- Stream Deck 機種と software version

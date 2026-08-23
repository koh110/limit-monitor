# limit-monitor

Codex CLI / Claude Code の利用上限を各ホストで収集し、自宅サーバーの Limit Hub へ集約して
Web Dashboard / Stream Deck / iPhone から確認するための基盤。

仕様の詳細は `docs/architecture.md` と `docs/decisions.md` を参照。

## 構成

| package | 役割 |
| --- | --- |
| `packages/shared` | Observation/Status の契約 schema、freshness/残量計算、Drizzle DB schema |
| `packages/hub` | Limit Hub。Hono + @hono/node-server。Ingest/Status API、SQLite 永続化 |
| `packages/client` | Web Dashboard。Next.js App Router + React |
| `packages/collector` | Collector。Phase 1 では Codex/Claude fixture を送信する Linux mock collector |

- ランタイム: Node.js 24.x
- DB: SQLite(Node `node:sqlite`)+ Drizzle ORM(`drizzle-orm/node-sqlite`)
- ツールチェーン: npm workspaces + TypeScript + vite-plus(`vp test` / `vp fmt` / `vp lint`)

## セットアップ

```bash
npm ci
npm run build -w shared
```

### Hub の起動

```bash
npm run db-migrate -w hub          # migration の適用(起動時にも自動適用される)
npm run dev:hub                    # http://0.0.0.0:8787
```

### Collector token の発行

```bash
npm run tokens -w hub -- issue --source-id dev-machine
```

平文 token は発行時に 1 回だけ表示される。Hub には hash のみ保存される。

### mock collector の実行(Phase 1)

```bash
HUB_TOKEN=<発行した token> SOURCE_ID=dev-machine npm run start -w collector
```

Codex / Claude の fixture 観測値が Hub へ送信される。

### Dashboard の起動

```bash
npm run dev:client                 # http://localhost:3000
```

Hub の URL は環境変数 `HUB_BASE_URL` で指定する(既定: `http://127.0.0.1:8787`)。

## 開発コマンド

各 package で共通:

```bash
npm run format-check -w <pkg>
npm run lint -w <pkg>
npm run build -w <pkg>
npm run test-ci -w <pkg>
```

Vitest / Prettier を直接実行せず、必ず `vp test` / `vp fmt` / `vp lint` を経由する。

## 運用

systemd unit template は `deploy/systemd/` を参照。手順は `docs/operations.md`。

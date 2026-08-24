# limit-monitor

Codex CLI / Claude Code の利用上限を各ホストで収集し、自宅サーバーの Limit Hub へ集約して
Web Dashboard / Stream Deck / iPhone から確認するための基盤。

仕様の詳細は `docs/architecture.md` と `docs/decisions.md` を参照。

## 構成

| package | 役割 |
| --- | --- |
| `packages/shared` | Observation/Status の契約 schema、freshness/残量計算、Drizzle DB schema |
| `packages/hub` | Limit Hub。Hono + @hono/node-server。Ingest/Status API、SQLite 永続化 |
| `packages/client` | Web Dashboard。Vite + React + react-router(data loader)。ブラウザから Hub へ直接 CORS 経由でアクセスする SPA |
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
npm run tokens -w hub -- issue --source-id dev-machine --account-alias main
```

`sourceId` と`accountAlias`の組み合わせごとにtokenを発行する。同じsourceで複数アカウントを収集する場合は、accountAliasごとに別tokenを発行する。
平文 token は発行時に1回だけ表示され、Hubにはhashのみ保存される。accountAliasはtokenからHub側で確定するため、collector側の設定は不要。

### mock collector の実行(Phase 1)

```bash
HUB_TOKEN=<発行した token> SOURCE_ID=dev-machine npm run start -w collector
```

Codex / Claude の fixture 観測値が Hub へ送信される。

### Dashboard の起動

```bash
npm run dev:client                 # http://localhost:5173
```

Dashboard はブラウザから Hub へ直接 fetch する SPA(reverse proxy なし)。Hub の URL は
build 時に焼き込まれる環境変数 `VITE_HUB_BASE_URL` で指定する(既定: `http://127.0.0.1:8787`)。
Hub 側では、この Dashboard の origin を `CORS_ALLOWED_ORIGINS` に許可 origin として設定する必要がある
(開発時の既定 origin は `http://localhost:5173`)。

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

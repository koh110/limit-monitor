# limit-monitor

Codex CLI / Claude Code の利用上限を収集し、Hub APIとWeb Dashboardで確認するNode.jsアプリケーションです。

## 構成

```text
Codex CLI / Claude Code
        │
        ▼
limit-collector ──▶ limit-hub ──▶ limit-dashboard
                    SQLite       React SPA
```

- `limit-collector`: ローカルのCodex / Claude CLIから実値を取得してHubへ送信
- `limit-hub`: 認証、観測値の保存、Dashboard向けAPI
- `limit-dashboard`: Hub APIを表示するWeb Dashboard

既定ではmock値を使いません。fixtureを使う場合だけ`COLLECTOR_MODE=mock`を明示します。

## 必要環境

- Node.js 24.x
- npm
- Codex CLI / Claude Code（Collectorを使う場合）
- Collectorを実行するユーザーでCodex / Claudeへlogin済みであること

## 開発環境

```bash
npm ci
npm run build --workspaces --if-present
npm run test --workspaces --if-present
```

Hubを起動:

```bash
npm run db-migrate -w hub
npm run dev:hub
# http://127.0.0.1:8787
```

Dashboardを起動:

```bash
npm run dev:dashboard
# http://localhost:5173
```

Collectorを手動起動する場合は、Hub tokenを環境変数で渡します。

```bash
HUB_TOKEN=<token> \
SOURCE_ID=<source-id> \
npm run start -w collector
```

実CLIから収集する既定モード:

```bash
COLLECTOR_MODE=real
```

明示的にmockを使う場合:

```bash
COLLECTOR_MODE=mock HUB_TOKEN=<token> SOURCE_ID=<source-id> \
  npm run start -w collector
```

## Deploy

正規の入口はリポジトリrootの`deploy.ts`です。

```bash
# Hub + Dashboard
VITE_HUB_BASE_URL=http://127.0.0.1:8787 \
  sudo -E ./deploy.ts --server

# Collector
VITE_HUB_BASE_URL=http://127.0.0.1:8787 \
  sudo -E ./deploy.ts --collector

# 全サービス
VITE_HUB_BASE_URL=http://127.0.0.1:8787 \
  sudo -E ./deploy.ts --server --collector
```

`--server`はHubとDashboard、`--collector`はCollectorを対象にします。何も指定しない場合や未知の引数は失敗します。

Deployを実行した通常ユーザーが、3サービスのsystemd実行ユーザーになります。専用Linux userやgroupを作成する必要はありません。`sudo`経由では`SUDO_USER`とそのprimary groupを自動解決します。rootへ直接loginして実行する場合は、主体を特定できないため拒否されます。

初回は、通常ユーザーでbuildを作成してからdeployします。

```bash
VITE_HUB_BASE_URL=http://127.0.0.1:8787 \
  ./deploy/deploy.sh --prepare-build

VITE_HUB_BASE_URL=http://127.0.0.1:8787 \
  sudo -E ./deploy.ts --server --collector
```

Collectorをdeployする場合、同じinstallユーザーでCodex / Claude CLIへlogin済みである必要があります。既存のenv、token、手編集されたsystemd unitはdeployで黙って上書きしません。

初回token bootstrap、環境変数、rollback、CORS、systemd状態確認は[`docs/operations.md`](docs/operations.md)を参照してください。

## サービスと既定ポート

- Hub: `127.0.0.1:8787`
- Dashboard: `127.0.0.1:3000`
- Collector: listenなし

DashboardはNode.js組み込みHTTP serverで配信するため、nginxは必須ではありません。LANへ公開する場合はDashboardのbind address、public origin、HubのCORSを明示的に一致させてください。

## API契約

APIの正本はTypeSpecです。

```bash
npm run compile -w shared
npm run openapi-ts -w shared
```

通常は`npm run build -w shared`から自動実行されます。

## ドキュメント

- [Architecture](docs/architecture.md)
- [Operations / Deploy](docs/operations.md)
- [Decisions](docs/decisions.md)
- [Security](SECURITY.md)

## License

未定義です。公開前にLICENSEを追加してください。

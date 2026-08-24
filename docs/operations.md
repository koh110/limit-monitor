# Operations

## 前提

- Node.js 24.x
- リポジトリ配置先の例: `/opt/limit-monitor`
- DB 配置先の例: `/var/lib/limit-monitor/limit-monitor.sqlite`(永続 volume)

## 初期構築(Hub)

```bash
cd /opt/limit-monitor
npm ci
npm run build -w shared
npm run build -w hub
DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite npm run db-migrate -w hub
```

systemd unit を配置して起動する:

```bash
sudo cp deploy/systemd/limit-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now limit-hub
```

起動確認:

```bash
curl -s http://127.0.0.1:8787/healthz
curl -s http://127.0.0.1:8787/readyz
```

Hub は起動時に migration を自動適用するため、再起動だけで schema が追従する。

## Collector token の管理

```bash
# 発行(平文 token はこの 1 回だけ表示される)
npm run tokens -w hub -- issue --source-id dev-machine

# 一覧
npm run tokens -w hub -- list

# 失効
npm run tokens -w hub -- revoke --source-id dev-machine
```

token は端末ごとに分離し、collector ホスト側では systemd credentials で注入する:

```bash
sudo install -m 600 -o root -g root /dev/stdin /etc/limit-monitor/collector-token <<< '<token>'
```

## Collector(mock)の運用

```bash
sudo cp deploy/systemd/limit-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now limit-collector
```

unit 内の `SOURCE_ID` は token を発行した sourceId と一致させる。
`COLLECTOR_INTERVAL_SECONDS=60` で常駐送信、`0` なら oneshot。

## Dashboard の運用

```bash
npm run build -w shared
npm run build -w client
VITE_HUB_BASE_URL=http://localhost:8787 npm run dev -w client -- --port 5173
```

Dashboard は Vite の開発サーバー(既定ポート 5173)で配信される。Hub 側では、Dashboard の
オリジンを `CORS_ALLOWED_ORIGINS`(例: `http://localhost:5173`)に登録する必要がある。
CORS の origin 一致は完全一致(exact string match)のため、`localhost` と `127.0.0.1` は
別 origin として扱われる点に注意する。

クライアント開発時は Vite 開発サーバー(既定ポート 5173、`npm run dev -w client`)を使用し、
本番相当のビルド確認は `start`/`preview` コマンド(ポート 3000、`npm run start -w client`)を使用する。

## アップグレード

```bash
cd /opt/limit-monitor
git pull
npm ci
npm run build -w shared && npm run build -w hub && npm run build -w client
sudo systemctl restart limit-hub
```

## バックアップ / リストア

SQLite は WAL mode のため、稼働中のバックアップには sqlite3 の `.backup` を使う:

```bash
sqlite3 /var/lib/limit-monitor/limit-monitor.sqlite ".backup /var/backups/limit-monitor.sqlite"
```

リストアは Hub 停止 → ファイル差し替え → 起動。

## ログ

```bash
journalctl -u limit-hub -f
```

- 構造化(JSON)ログ。access ログには requestId / method / path / status / duration が入る
- token、vendor response 全文、認証情報はログへ出力しない
- `/healthz` で version と schemaVersion を確認できる

## トラブルシュート

| 症状 | 確認 |
| --- | --- |
| `readyz` が 503 | DB ファイルの権限、`ReadWritePaths` の設定 |
| ingest が 401 | token の失効状態(`tokens list`)、Bearer header |
| ingest が 403 | payload の `sourceId` と token の sourceId の一致 |
| ingest が 400 | `observedAt` が Hub 時刻より 5 分以上未来でないか(clock skew) |
| ingest が 429 | 送信間隔(rate limit: sourceId ごと 120 req/分) |
| Dashboard が OFFLINE | Hub の稼働、`VITE_HUB_BASE_URL` |
| Dashboard から fetch が CORS エラー | Hub の `CORS_ALLOWED_ORIGINS` に Dashboard のオリジン(既定 `http://localhost:5173`)が含まれているか |

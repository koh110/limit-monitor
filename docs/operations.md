# Operations

## 前提

- Node.js 24.x
- npm
- release 配置先(既定): `/var/www/limit-monitor`
- DB 配置先(既定): `/var/lib/limit-monitor/limit-monitor.sqlite`
- Collectorで選択するproviderに応じた実行環境
  - Codex: install userでCodex CLIへlogin済み
  - Claude: install userでClaude Codeへlogin済み
  - Grok: install userでGrok CLIへlogin済みで、ACP billing APIを呼び出せること

正規のdeploy入口はリポジトリrootの`./deploy.ts`です。deploy orchestrationはTypeScriptで行い、`npm`、`systemctl`、`runuser`、`systemd-analyze`等の外部コマンドはshell文字列を組み立てず、引数配列で直接実行します。

## release構成

```text
/var/www/limit-monitor/
  versions/0.1.0/
  versions/0.0.1/
  current -> versions/0.1.0
```

`package.json`のversionをrelease directory名として使います。`current`は一時symlinkを作ってからrenameするため、切替はatomicです。既定では過去5versionを保持し、`KEEP_VERSIONS`で変更できます。

## 基本deploy

```bash
# Hub + Dashboard
sudo ./deploy.ts --server --hub-base-url http://127.0.0.1:8787

# Collector
sudo ./deploy.ts \
  --collector \
  --providers codex,claude,grok \
  --hub-base-url http://127.0.0.1:8787

# 全サービス
sudo ./deploy.ts \
  --server --collector \
  --providers codex,claude,grok \
  --hub-base-url http://127.0.0.1:8787
```

`--server` / `--collector`のどちらも指定しない場合、未知の引数、同じoptionの重複指定はfail-closedで拒否します。同じversionを明示的に再配置する場合だけ`--force`を付けます。

```bash
sudo ./deploy.ts \
  --server --collector \
  --providers codex,claude,grok \
  --force \
  --hub-base-url http://127.0.0.1:8787
```

`--dry-run`は副作用なしでdeployment planだけを表示します。

## Provider設定の永続化

provider選択のsource of truthは`/etc/limit-monitor/collector.env`の`COLLECTOR_PROVIDERS`です。systemd unit側にproviderの一時overrideは置きません。

```bash
sudo ./deploy.ts \
  --collector \
  --providers grok \
  --hub-base-url http://127.0.0.1:8787
```

上記を実行すると、deployは次の順序で処理します。

1. CLI引数のproviderを正規化し、空要素・未知provider・重複を拒否する。
2. 既存`collector.env`があればそれを読み、activeな重複env keyがないことを確認する。
3. `COLLECTOR_PROVIDERS`だけを差し替えたcandidateをメモリ上で作る。他の設定・コメントは保持する。
4. candidateを使って選択providerの検証を行う。Grok-onlyならCodex/Claude CLIは要求しない。
5. token、systemd unit、state directory等を含むread-only validationをすべて完了する。
6. validation成功後だけ、candidateを`collector.env`へatomicに配置する。既存mode/ownerは保持する。

`--providers`を省略した場合、既存`collector.env`は書き換えません。そこに永続化されている`COLLECTOR_PROVIDERS`をそのまま利用します。既存envがない初回deployでのみ`deploy/collector.env.example`の既定値を使います。

`--providers`は`--collector`と組み合わせた場合だけ受理します。

## service実行ユーザー

Hub / Dashboard / Collectorはすべて、deployを実行した通常ユーザーをsystemdの`User=`として使います。専用Linux user/groupは作成しません。

解決順は次の通りです。

1. `sudo`経由なら`SUDO_USER`
2. 非root実行なら現在のユーザー
3. root直接実行で主体が不明ならfail-closed

実deployはsystemd操作を行うためrootが必要です。通常は通常ユーザーのshellから`sudo ./deploy.ts ...`として実行してください。uid 0、存在しないuser/group、実在するhome directoryを持たないuserは拒否します。

Codex / Claude CLIの存在確認もこのinstall userとして行います。

## build

deployはbuildを自分で実行します。`npm ci`とworkspace buildはrootではなくinstall userとして実行します。

build対象:

- shared
- hub
- collector
- dashboard (`VITE_HUB_BASE_URL`をbuild時に注入)

必要artifactが生成されていなければ配置前に停止します。その後、本番依存だけを含むstaging releaseを作成し、entrypoint import等を検証します。

## managed env

既定のmanaged env:

- `/etc/limit-monitor/hub.env`
- `/etc/limit-monitor/dashboard.env`
- `/etc/limit-monitor/collector.env`

`INSTALL_DIR`は絶対pathである必要があり、`/`は拒否します。既存envはduplicate active keyを拒否します。

Hub/Dashboard deployではDashboard originとHub CORSを整合させます。Collector deployでは、`--providers`を明示した場合だけ既存`collector.env`のprovider選択を更新します。

## Collector token

Collector tokenはenvへ平文で置かず、systemd credentialで渡します。

```bash
sudo install -d -m 0755 /etc/limit-monitor
sudo install -m 600 /dev/stdin /etc/limit-monitor/collector-token
```

`collector-token`は次を満たす必要があります。

- 通常ファイルでsymlinkではない
- root所有
- mode `600`
- trim後に空でない

unitは次の形でtokenを受け取ります。

```ini
LoadCredential=hub-token:/etc/limit-monitor/collector-token
Environment=HUB_TOKEN_FILE=%d/hub-token
```

## systemd unit

管理対象unit:

- `limit-monitor-hub.service`
- `limit-monitor-dashboard.service`
- `limit-monitor-collector.service`

unit templateの`User=CHANGE_ME` / `Group=CHANGE_ME`とNode.js pathはdeploy時にrenderします。配置前に`systemd-analyze verify`を実行します。

既存unitを更新できるのはdeploy管理markerを持つunitだけです。手編集された非管理unitは黙って上書きせず停止します。管理unit更新時はbackupを作成してからatomicに置き換えます。

Collectorは常駐Agentとして`Type=simple`でrenderします。定期triggerの間隔はHubの`COLLECTOR_TRIGGER_INTERVAL_SECONDS`で設定し、Collector側にscheduler用のinterval設定は置きません。

## state directory

既定は`/var/lib/limit-monitor`です。既存する場合はinstall user/group所有、mode `0755`である必要があります。

初回は通常ユーザー名/group名を使って準備できます。

```bash
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 /var/lib/limit-monitor
```

## 初回token発行

```bash
SOURCE_ID=dev-machine
ACCOUNT_ALIAS=local
DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite \
  npm run -s db-migrate -w hub

DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite \
  npm run -s tokens -w hub -- issue \
  --source-id "$SOURCE_ID" --account-alias "$ACCOUNT_ALIAS"
```

表示されたtokenを`/etc/limit-monitor/collector-token`へmode `600`で配置してからdeployします。

## fail-closed validation

配置前に少なくとも次を検証します。

- `INSTALL_DIR`、Hub URL、package version
- install user / primary group / home
- build artifact / production dependency staging
- managed envのduplicate keyと値
- provider listと選択したCodex/Claude CLIの実行可能性
- Collector token
- state directory owner/mode
- systemd unit templateと`systemd-analyze verify`
- 既存systemd unitがdeploy管理対象か

これらが成功するまでmanaged env、unit、release配置へ進みません。

## service起動

unit配置後に`systemctl daemon-reload`し、対象unitをenableして起動/再起動します。各操作後にread-backします。

Hubは`/readyz`が成功するまで待機してからDashboardを起動します。timeoutは`LIMIT_MONITOR_HUB_READY_TIMEOUT_SECONDS`で変更でき、既定30秒です。

Collectorは常駐Agent（`Type=simple`）として起動し、`is-active=active`を確認します。収集時に起動するWorker subprocessの終了結果はAgentが監視し、manual refreshの状態へ反映します。

## rollback

`versions/`に旧releaseが残っている場合、緊急時は`current`を旧versionへ戻して対象serviceを再起動できます。

```bash
cd /var/www/limit-monitor
sudo ln -sfn versions/<previous-version> .current.rollback
sudo mv -T .current.rollback current
sudo systemctl restart limit-monitor-hub limit-monitor-dashboard limit-monitor-collector
```

DB migrationを伴う変更では、application rollbackだけで互換性が戻るとは限りません。migrationのforward/backward compatibilityを別途確認してください。

## 確認コマンド

```bash
systemctl status limit-monitor-hub
systemctl status limit-monitor-dashboard
systemctl status limit-monitor-collector
journalctl -u limit-monitor-hub -n 100 --no-pager
journalctl -u limit-monitor-dashboard -n 100 --no-pager
journalctl -u limit-monitor-collector -n 100 --no-pager
```

# Operations

## 前提

- Node.js 24.x
- release 配置先(既定): `/var/www/limit-monitor`
- DB 配置先(既定): `/var/lib/limit-monitor/limit-monitor.sqlite`(永続 volume)
- Collector を動かすホストに Codex CLI(`codex`)と Claude Code(`claude`)が
  インストールされ、**login 済み**であること

配置先は `deploy/deploy.sh` の `INSTALL_DIR` と systemd の `EnvironmentFile` で
差し替えられる(unit を編集せずに変更できる)。

## release 構成

`deploy/deploy.sh` は version ディレクトリと symlink で配置する:

```text
/var/www/limit-monitor/
  versions/0.1.0/   # package.json の version に対応する build 済み artifact + 本番依存のみの node_modules
  versions/0.0.1/
  current -> versions/0.1.0
```

systemd unit と Node.js dashboard service は常に `current` を参照する。`current` の入れ替えは
`mv -T` による atomic な symlink 差し替えで行うため、切り替え中に
中途半端な状態を読まれない。

## deploy

利用者向けの入口はリポジトリ root の `./deploy.ts` だけで、対象サービスを明示する。
**clean hostの初回構築では、下の「初期構築」Phase 0でstate directory・DB・tokenを準備してからdeployする。**
build manifestが無い、またはsource / lockfile / artifactが古い場合は、deployが`SUDO_USER`の通常ユーザーとして`--prepare-build`を自動実行する。

```bash
sudo ./deploy.ts --hub-base-url <url> --server              # Hub + Dashboard
sudo ./deploy.ts --hub-base-url <url> --collector           # Collector
sudo ./deploy.ts --hub-base-url <url> --server --collector  # 全サービス
```

```bash
# repositoryのcheckout rootで、通常ユーザーとして実行
# clean hostでも、ここで手動prepare-buildする必要はない。
# sudo deploy時にbuildが必要なら、SUDO_USERとして自動実行される。
git pull
sudo ./deploy.ts --hub-base-url <url> --server --collector
```

自動prepare-buildはrootでは実行せず、`sudo`を呼び出した`SUDO_USER`として
`npm ci`と全workspace buildを実行する。`SUDO_USER`がないroot直接実行では、
通常ユーザーを特定できないためfail-closedで停止する。自動実行を待たずに手動で
buildしたい場合は、通常ユーザーで次を実行できる:

```bash
VITE_HUB_BASE_URL=http://127.0.0.1:8787 deploy/deploy.sh --prepare-build
```

`--server` / `--collector` のどちらも指定しなければ何も deploy しない(fail-closed)。
未知の引数も同様に拒否する。`--dry-run` は委譲先コマンドを表示するだけ。
同じ `package.json` version を再配置する場合だけ、明示的に `--force` を付ける:

```bash
sudo ./deploy.ts --server --collector --force --hub-base-url <url>
```

`--force` なしでは既存の version directory を置き換えず、`--force` 指定時も
通常どおり全検証を完了してから対象 directory を再作成する。

**service 実行ユーザー(install user)を利用者に指定させない。** 入口にも
`deploy/deploy.sh` にも `--user` / `--group` option は無く、ユーザー指定の環境変数
(`COLLECTOR_USER` / `COLLECTOR_GROUP` / `LIMIT_MONITOR_INSTALL_USER` /
`LIMIT_MONITOR_INSTALL_GROUP`)も廃止した。詳細は下の「service 実行ユーザー」を参照。

`deploy/deploy.sh` を直接実行してもよいが、その場合も **対象サービスを
`--services` で明示する**(`--services server,collector` など。空 / 未知 / 重複は
fail-closed)。identity は同じ規則で自動解決される:

```bash
VITE_HUB_BASE_URL=http://127.0.0.1:8787 \
  sudo ./deploy.ts --hub-base-url <url> --server --collector --services server,collector
```

### service 実行ユーザー(install user)

**limit-monitor 専用の Linux user は作らないし前提にもしない。** Hub / Dashboard /
Collector の 3 unit、`/var/lib/limit-monitor` の owner、Hub token CLI の実行
identity はすべて **install を実行した通常ユーザー** に揃える。解決順:

1. `sudo` 経由なら `SUDO_USER`(root 以外の実ユーザー)
2. 非 root 実行なら現在のユーザー(systemd 操作には root が必要なため、その先で
   root チェックに掛かり「sudo で実行し直す」案内が出る)
3. root 直接で `SUDO_USER` が無い場合は主体不明として **fail-closed**

group は `getent passwd` の gid を `getent group` で引いた primary group に固定する。
uid 0 のアカウント、存在しない user / group、home directory が実在しないアカウントは
受理しない(real mode の collector は `codex` / `claude` CLI を起動し、CLI 自身が
HOME 配下の login 情報を読むため)。

以降このドキュメントでは、解決される install user / group を
`<install-user>` / `<install-group>` と書く(実際には deploy を実行する自分の
アカウントとその primary group)。

主なオプション / 環境変数:

| 変数 / option | 既定 | 用途 |
| --- | --- | --- |
| `INSTALL_DIR` / `--install-dir` | `/var/www/limit-monitor` | release 配置先(絶対 path 必須) |
| `VITE_HUB_BASE_URL` / `--hub-base-url` | **必須** | Dashboard に焼き込む Hub の URL |
| `package.json` の `version` | 例: `0.1.0` | version ディレクトリ名。deployごとにversionを更新する |
| `KEEP_VERSIONS` / `--keep-versions` | `5` | 残す過去 version 数(1 以上) |
| `--force` | 無効 | 同じ `package.json` version の既存 version directory を明示的に置き換える |
| `DEPLOY_RESTART` / `--restart` | `0`(再起動しない) | systemd service を再起動する |
| `DEPLOY_INSTALL_SYSTEMD` / `--install-systemd` | `0` | unit render・検証・配置、daemon-reload、enable/start/restart を行う |
| `DEPLOY_PREPARE_BUILD` / `--prepare-build` | - | 非 root のみ。`npm ci` + 全 workspace build + `VITE_HUB_BASE_URL` での Dashboard build + build manifest 生成で終了(staging / systemd なし)。root では die。`sudo` + `--install-systemd` 実行時は script が先に SUDO_USER として自動再実行する |
| `DEPLOY_SERVICES` / `--services` | `server,collector` | 対象サービス(`server` = hub + dashboard、`collector`)。`./deploy.ts` は `--server` / `--collector` から明示的に渡す。空 / 未知 / 重複は fail-closed |
| `SKIP_NPM_CI` / `--skip-npm-ci` | `0` | `npm ci` を省略する |
| `HUB_SERVICE` / `DASHBOARD_SERVICE` / `COLLECTOR_SERVICE` | `limit-monitor-hub` / `limit-monitor-dashboard` / `limit-monitor-collector` | 対象 unit 名(**既定値のみ対応**。カスタム名は unit 名 / 依存関係と連動しないため fail-closed で事前拒否) |

`deploy/deploy.env` を置くと同じ変数をファイルで与えられる(環境変数が優先)。

script は fail closed で、次のいずれかを満たさない場合は**何も置き換えずに終了する**:

- `INSTALL_DIR` が絶対 path でない / `/` である
- `VITE_HUB_BASE_URL` が未設定、または `http(s)://` で始まらない
- `node` / `npm` / `git` などの必須 tool が無い
- 同じ `package.json` の `version` の version directory が既に存在する(`--force` なし)
- build manifest / artifactが無い、またはsource / lockfile / artifact digestが古い状態のまま自動prepare-build後も一致しない
- `--prepare-build` が root で実行された(npm は決して root で実行しない)
- SUDO_USER 無い root シェル(root 直接)で既存の build manifest / artifacts が無い(npm を実行しない。先に通常ユーザーで `--prepare-build` を実行する)
- staging での本番依存 install、または entrypoint の import 検証に失敗した
- `--services` が空 / 未知の target / 重複を含む(対象サービスの選択は常に明示)
- 廃止した `COLLECTOR_USER` / `COLLECTOR_GROUP` / `LIMIT_MONITOR_INSTALL_USER` / `LIMIT_MONITOR_INSTALL_GROUP` が環境や `deploy/deploy.env` に設定されている(黙って無視せず拒否する)
- `--install-systemd` 時に install user を解決できない(root 直接で `SUDO_USER` が無い)、または解決した user が uid 0 / 実在しない / home directory が無い、その primary group を `getent group` で引けない
- `HUB_SERVICE` / `DASHBOARD_SERVICE` / `COLLECTOR_SERVICE` が既定値(`limit-monitor-hub` / `limit-monitor-dashboard` / `limit-monitor-collector`)と異なる(カスタム unit 名は未対応のため事前拒否)
- `--install-systemd` 時に render 済み unit に `CHANGE_ME` placeholder が残る、または ExecStart が存在しない node path を指す
- `--install-systemd` 時に `systemd-analyze verify` が失敗する(警告には落とさない)
- `--install-systemd` 時に `/etc/limit-monitor/{hub,dashboard,collector}.env`、`collector-token`、Hub の CORS 設定に不整合がある
- `--install-systemd` 時に `collector-token` が symlink / 非通常ファイル / root 以外 / mode 600 でない / 空(trim 後)
- `--install-systemd` 時に `CODEX_BIN` / `CLAUDE_BIN`(有効 provider 分)が絶対 path でない(bare command `codex` や `./codex` 等の相対 path は不可)、または install user の実行環境で存在しない、または実行不可能
- `--install-systemd` 時に `/var/lib/limit-monitor` の owner / mode が install user と一致しない
- `--install-systemd` 時に **手編集された(非管理) systemd unit** が既存する(管理対象 unit は backup 付きで atomic 更新される。非管理 unit は上書きしない)

これらの検証は **`current` symlink の切替の前** に行われるため、失敗時は新しい
release にも旧 unit にも触れず、`current` は変更されない。

`--install-systemd` の `enable` / `restart` / `start` が失敗した場合は `die` で止まる。
この時点では `current` が新 release を指し始めているため、`journalctl -u <unit>`
で原因を確認し、必要なら `current` を旧 release へ戻して再起動する。

`--restart` を付けない限り service は再起動しない(release を置くだけ)。
`--install-systemd` は unit 配置と `daemon-reload`、`enable` →
`restart`(active の場合)または `start`(inactive の場合)をまとめて行う。
各操作の後に `is-enabled` / `is-active` を read-back して確認する。

### Dashboard の Hub URL は build 時に確定する

Dashboard は reverse proxy を介さずブラウザから Hub を直接叩く SPA なので、
Hub の URL は Vite の static build に焼き込まれる。`VITE_HUB_BASE_URL` を
変更したら **必ず deploy をやり直す**(既存 release の差し替えでは変わらない)。
`--hub-base-url`を指定したdeployでは、既存`dashboard.env`の
`DASHBOARD_PUBLIC_ORIGIN`(未指定のlocalhost bindならHOST/PORTから導出)を読み取り、
そのoriginが`hub.env`の`CORS_ALLOWED_ORIGINS`に無ければ自動追加する。Hub envの
他の値、DashboardのHOST/PORT、token、DB pathは変更しない。

## 初期構築

### Phase 0: 初回 collector token bootstrap(clean host)

`--install-systemd` は `collector-token`(root 所有・mode 600)と
`/var/lib/limit-monitor`(install user 所有・mode 0755)を**事前検証**し、
無い・不一致なら current 切替前に die する(fail-closed)。初回は次の順番で実行する:

1. 実 git checkoutを、deployを実行する通常ユーザーが読取・書込できる場所に配置
2. rootでstate directoryをinstall user所有に作成
3. install userでDB migrationとHub token発行
4. rootで`/etc/limit-monitor/collector-token`を配置
5. `sudo ./deploy.ts --server --collector --hub-base-url <url>`を実行する
   (buildが未生成・古い場合は、このdeployがinstall userとして自動prepare-buildする)

`--prepare-build`を手動で先に実行する必要はない。tokenを配置する前にdeployを
実行すると、unit配置前に`missing collector token`で停止する。
次の詳細手順はすべてrepository checkoutのrootで実行する
(0-3はcheckoutの絶対pathを使うためcwdに依存しない)。

install user(= deploy を実行する自分の通常ユーザー)と group は次で確認できる:

```bash
id -un   # <install-user>
id -gn   # <install-group>
```

#### 0-0. 前提: checkout の path が install user に traverse / read 可能であること

0-1 の build と 0-3 の token CLI(`db-migrate` / `tokens issue`)は install user で
実行するため、checkout への**全親 directory を traverse(x 権限)**でき、かつ
**checkout 内を read** できる必要がある。install user は通常ユーザーなので、
自分の HOME 配下の checkout でも成立する。共有ホストで別アカウントからも
運用したい場合は `/srv/limit-monitor` / `/opt/limit-monitor` のような
共有可能な場所へ置く。

- **`/root` 配下は不可**:`/root` は通常 mode 0700(root のみ)のため、
  install user は traverse できない。
- checkout ルートと内部ファイルは install user が read 可能であること
  (例: directory 0755 / file 0644。他人所有の 0600 のファイルは不可)。
- checkout は **実 git checkout(`.git` を含む)** であること。0-1 の
  `--prepare-build` は `git ls-files` による tracked files の source digest を
  manifest に記録するため git repository が必須で、非 repository では digest
  が空になり fail-closed で die する。**`git archive`、source-only copy、
  `.git` 除外 copy は不可**。
- checkout directory と `--prepare-build` が書き込む `node_modules` / `dist` は、
  0-1 を実行する **build user(通常ユーザー)が所有・書込み可能** であること。
  root 所有の copy を配置して非 root で build する手順は使わない。

実行前チェック(install user が checkout まで traverse / read できることを確認する):

```bash
namei -l /absolute/path/to/limit-monitor-checkout
```

出力の各行は path の各構成要素。`/` から checkout ルートまでの各親 directory を
install user が traverse でき、checkout 内のファイルを read できることを確認する。
`namei` がない場合は、各親 dir を 1 段階ずつ
`stat -c '%A %U:%G %n' / /srv /srv/limit-monitor ...` のように mode を見て確認する。

既存の作業 checkout を新しい場所に移す場合は:

- **build user(通常ユーザー)として、秘密情報(`.env`、`collector-token`、
  credential 等)を含めない実 git checkout(`.git` を含む)を配置する**。
  作業ディレクトリごとそのまま移動しないこと。`.git` を含めること
  (source-only copy / `.git` 除外 copy / `git archive` は不可)。
- checkout directory と内部(`.git` / `node_modules` / `dist`)の所有が
  build user でない場合(例: root 所有の copy が残った場合)、
  `chown` で所有者を **安全に build user へ設定**する。
- **root で npm を実行しない**。手動でbuildする場合は0-1を通常ユーザーで行う。
  手動buildを省略した場合は、systemd deployが`SUDO_USER`として自動実行する。

例(placeholder path を実際の配置先へ置き換える):

```bash
sudo install -d -m 0755 /srv/limit-monitor
# /srv/limit-monitor へ実 git checkout(.git を含む。秘密ファイル .env 等は含まない)を配置する
# (git clone するか、.env 等を除外した git checkout のコピー。source-only copy は不可)
# 配置後、checkout directory と node_modules / dist が build user が所有・書込み
# 可能であることを確認する(chown が必要なら所有者を build user へ設定)
# 配置後、必要ならその checkout で 0-1 の --prepare-build を通常ユーザー(非 root)で実行する
# 手動実行しない場合は、sudo deployがSUDO_USERとして自動実行する
```

#### 0-1. 手動で `--prepare-build`する場合(任意、npm を root で実行しない)

0-0 で配置した **実 git checkout(`.git` を含む)で、build user(通常ユーザー)として
実行する**(`node_modules` / `dist` がそのユーザーに書込み可能であること):

```bash
VITE_HUB_BASE_URL=http://127.0.0.1:8787 deploy/deploy.sh --prepare-build
```

`npm ci` + 全 workspace build + `VITE_HUB_BASE_URL` での Dashboard build + build
manifest 生成(`git ls-files` による source digest を含む)で終了する。root では
die する(許可しない)。build manifest が
stale(無い / digest 不一致)のとき `sudo ./deploy.ts --hub-base-url <url> --install-systemd` を実行すると
script が `SUDO_USER` として自動再実行する。SUDO_USER 無い root シェルでは
fail-closed で die するため、通常ユーザー経由の `sudo` でdeployすること。

#### 0-2. root で state dir を install user 所有に初期化する

**Linux user / group は作らない。** `/var/lib/limit-monitor` は
「install を実行する通常ユーザー」の所有にする:

```bash
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 /var/lib/limit-monitor
```

`$(id -un)` / `$(id -gn)` は install user 本人のシェル(sudo する前の自分の
アカウント)で展開されるため、`sudo` を付けても対象は自分の user:group になる。
`install -d` は既存 dir の owner / mode を是正する(0755 = systemd
StateDirectory の既定値と一致)。deploy.sh 側でも同値で事前検証するため、
この値から外れると die する。

#### 0-3. checkout の Hub token CLI で token を発行する(production DB path)

`db-migrate` と `tokens issue` は **install user** で実行する(実行 identity が
`/var/lib/limit-monitor` を所有する install user でないと、0755 state dir へ DB
ファイルを書けない)。install user は deploy を実行する自分のアカウントなので、
通常は checkout でそのまま実行すればよい(`sudo` も `runuser` も要らない):

```bash
SOURCE_ID=dev-machine
ACCOUNT_ALIAS=local
DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite npm run -s db-migrate -w hub
DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite \
  npm run -s tokens -w hub -- issue \
  --source-id "$SOURCE_ID" --account-alias "$ACCOUNT_ALIAS"
```

`SOURCE_ID` は後で配置される `collector.env` の `SOURCE_ID` と同じ値にする。

別アカウントの shell から実行する場合だけ install user へ切り替える
(`<install-user>` は 0-2 で state dir の owner にしたアカウント。placeholder
path は実際の checkout 絶対 path へ置き換える):

```bash
sudo -u <install-user> -- env \
  HOME=/home/<install-user> \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite \
  SOURCE_ID=dev-machine \
  ACCOUNT_ALIAS=local \
  bash -c 'cd /absolute/path/to/limit-monitor-checkout && npm run -s db-migrate -w hub'
sudo -u <install-user> -- env \
  HOME=/home/<install-user> \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite \
  SOURCE_ID=dev-machine \
  ACCOUNT_ALIAS=local \
  bash -c 'cd /absolute/path/to/limit-monitor-checkout && npm run -s tokens -w hub -- issue --source-id "$SOURCE_ID" --account-alias "$ACCOUNT_ALIAS"'
```

`HOME` は install user 自身の home directory(`getent passwd <install-user>` の
6 番目のフィールド)にする。PATH は node / npm が解決できる値にすること。
**`sudo npm` は使わない**(npm を root で実行しない)。

`DB_FILE_PATH` は Hub の production DB(既定
`/var/lib/limit-monitor/limit-monitor.sqlite` = `deploy/hub.env.example` と
systemd unit の `DB_FILE_PATH` と一致)を**絶対 path で**指定する。`tokens.ts`
は起動時に自動 migrate しないため、初回は先に `db-migrate` を同じ DB path で
実行する(上記の順: migration が先、issue が後)。`SOURCE_ID` は後で
`collector.env` の `SOURCE_ID` に一致させる値(既定例: `dev-machine`)。
平文 token は表示された**1 回だけ**に限り有効で、Hub 側には hash のみ保存
される。token 値はこのドキュメントに書かないこと。

#### 0-4. root で collector-token を配置する(placeholder 禁止)

0-3 の `tokens issue` 実行(install user)で一度だけ表示される**tokenのvalue**を、標準入力からroot所有の`collector-token` fileへ配置する。`collector-token`には、このtokenのvalueそのものが入る。token値をチャット、Git、command line argumentsへ書かない:

```bash
sudo install -d -m 0755 /etc/limit-monitor
sudo install -m 600 /dev/stdin /etc/limit-monitor/collector-token
```

`sudo install -m 600 /dev/stdin ...`を実行した後、表示されたtokenのvalueを端末へ貼り付ける。入力が終わったら**`Ctrl-D`を押して標準入力を閉じる**。`Ctrl-D`はtokenのvalueには含めない。これは「入力終了（EOF）」を伝えるキー操作であり、`Ctrl-C`ではない。
念のため権限をread-backする:

```bash
sudo chown root:root /etc/limit-monitor/collector-token
sudo chmod 600 /etc/limit-monitor/collector-token
sudo stat -c '%n owner=%U:%G mode=%a type=%F' /etc/limit-monitor/collector-token
```

期待値は`owner=root:root mode=600 type=regular file`。`validate_collector_token`は
symlinkでない通常ファイル・root所有・mode 600・trim後非空を要求し、既存tokenは
上書きしない。token配置前のdeployは`missing collector token`で停止する。

#### 0-5. root で初回 deploy を実行する(SUDO_USER 必須)

```bash
sudo ./deploy.ts --hub-base-url <url> --server --collector
```

**初回 root deploy は `sudo`(SUDO_USER 継承)が必須。** service 実行ユーザーは
`SUDO_USER` から解決するため、`sudo` でないと主体不明として fail-closed で
止まる(user / group を指定する option は無い)。SUDO_USER 無い root シェルでは
build manifest が stale なら npm を実行せず fail-closed で die する(0-1 を非 root
で実行済みなら manifest が一致するため成立するが、再実行経路のため `sudo` を
使う)。collector-token / state dir の検証不一致も fail-closed で止まる。

### 1. 初回 deploy と systemd 反映

(上記 Phase 0 の 0-0 → 0-5 の順を実行する。0-1 の手動prepare-buildは任意。
`--install-systemd` は `collector-token` と `/var/lib/limit-monitor` を current
切替前に検証するため、0-2 / 0-4 を済ませていない clean host でいきなり
`sudo ./deploy.ts --hub-base-url <url> --server --collector` を実行しても成立しない。)

`--install-systemd` は以下をまとめて行う:

- install user / group を解決する(`SUDO_USER` → 現在のユーザー → fail-closed。**Linux user は作らない**)
- `/var/lib/limit-monitor` を初期化(server を含む選択時・未存在時のみ、解決した install user:group 所有・mode 0755 で作成。既存なら owner / mode を検証し、不一致は拒否。0755 = systemd StateDirectory の既定値)
- deploy 時の実際の node path を `command -v node` で解決する
- 選択した service の unit を `/etc/systemd/system/limit-monitor-{hub,dashboard,collector}.service` へ **render 済みで** 配置する:
  unit template の `ExecStart=/usr/bin/node ...` を実 node path に、各 unit の
  `User=CHANGE_ME` / `Group=CHANGE_ME` を解決済み install user:group に置換する
- render 済み unit の検証(placeholder 残留なし / node path の存在 / `${INSTALL_DIR}` 残留 / `systemd-analyze verify`)
- `/etc/limit-monitor` を作成し、`hub.env` / `dashboard.env` / `collector.env` が無ければ example を初期配置(`INSTALL_DIR` を deploy 値へ整合)
- `collector-token`(root 所有・mode 600・通常ファイル・非空)と Hub の CORS 設定を検証
- 有効 provider の `CODEX_BIN` / `CLAUDE_BIN` を install user の実行環境で解決・実行可能性を検証
- **上記すべてを `current` symlink の切替の前に完了させる**(fail-closed)
- `systemctl daemon-reload` → 各 unit を `enable`(read-back)→ active なら `restart`、inactive なら `start` → active read-back(失敗時は die)

既存の env/token は上書きしない。systemd unit は **deploy.sh が管理する単位**で扱い、
unit 先頭に `# limit-monitor: managed by deploy/deploy.sh -- do not edit (edit env instead)`
の marker を付ける。既存 unit が **この marker を持つ(管理対象)** 場合は、内容が
render 済みと一致すればそのまま、不一致なら旧内容を `.bak-<UTC timestamp>` に backup
してから atomic に render 結果へ更新する(旧 unit から upgrade 可能)。更新時の
atomic temp は `/tmp` ではなく destination と同じ dir(例: `/etc/systemd/system`)
に `mktemp` で作成し、mode 設定後に同一 dir へ `mv -T`(rename)で配置する
(filesystem を跨ぐ `mv` は copy + unlink で atomic ではないため)。
**marker を持たない(手編集された / 外部由来) unit は一律拒否**されて上書きされない。
collector の token file が無ければ先に作成する必要がある(root 所有・mode 600)。

### 2. Hub token の発行(初回は Phase 0 0-3)

初回は Phase 0 の 0-3 で発行済みのはず。再発行・確認・失効は 0-3 と同じ
identity(install user)と production DB path で実行する。install user 自身の
shell なら次のとおり(npm は root で起動しない):

```bash
DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite npm run -s tokens -w hub -- list
DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite \
  npm run -s tokens -w hub -- revoke --source-id dev-machine --account-alias main
```

別アカウントの shell からは 0-3 と同じ形で install user へ切り替える:

```bash
sudo -u <install-user> -- env \
  HOME=/home/<install-user> \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite \
  bash -c 'cd /absolute/path/to/limit-monitor-checkout && npm run -s tokens -w hub -- list'
```

`sourceId` と `accountAlias` の組み合わせごとに token を発行する。同じ source で
複数アカウントを収集する場合は accountAlias ごとに別 token を発行する。平文 token は
発行時に 1 回だけ表示され、Hub には hash のみ保存される。`accountAlias` は token から
Hub 側で確定するため collector 側の設定は不要。再発行(`issue`)は既存 token を
置き換える(失効 + 新発行)ため、旧 token を collector-token に置いている場合は
0-4 と同様に新しい値へ差し替える。

### 3. Collector の実行

`limit-monitor-collector.service` は real mode では `codex` / `claude` CLI を実行し、CLI 自身が
自分の HOME 配下の login 情報を読む。collector は install user(= deploy を実行した
通常ユーザー)として動くため、**そのアカウントで `codex` / `claude` に login 済み**で
あること。`ProtectHome=false` のままにする。deploy 時にアカウントを指定する
option / 環境変数は無く、`sudo` の `SUDO_USER` から自動で決まる:

```bash
sudo ./deploy.ts --hub-base-url <url> --collector
```

`--install-systemd` は install user を解決できない場合(root 直接で `SUDO_USER` が
無い)や、解決した user / group が存在しない場合は unit を enable/start しない
(fail-closed)。

`systemd` 配下は PATH が細いため、CLI の絶対 path を `collector.env` に書く。
**install user の login shell 経由で解決**する(管理者の PATH では見つかる場合もある。
`runuser -l <user> -- command -v ...` の形式は使わない: -l だと -- の直後が
login shell として解釈され、CLI 名が shell とみなされて失敗するため):

```bash
# install user 自身の shell なら
command -v -- codex     # -> CODEX_BIN
command -v -- claude    # -> CLAUDE_BIN
# 別アカウントから解決する場合(<install-user> / <user_shell> は実値へ置き換える)
runuser -u <install-user> -- <user_shell> -lc 'command -v -- codex'
runuser -u <install-user> -- <user_shell> -lc 'command -v -- claude'
```

**node の path について(重要):** node は deploy 時の `command -v node` で解決し、
その path を全 unit(hub / dashboard / collector)の ExecStart へ render する。
hub / dashboard unit は `ProtectHome=true` なので **HOME 配下(`/home/<user>/...`
・`/root/...`)の node にはアクセス不能**である。そのため `--install-systemd`
は解決した node path が HOME 配下にある場合、current 切替前に fail-closed
で拒否する(HOME 外の node、例: `/usr/local/bin/node` / `/usr/bin/node` を使う
こと)。

`--install-systemd` は current 切替前に install user として
`CODEX_BIN` / `CLAUDE_BIN`(有効 provider 分のみ)が **絶対 path** であり、
install user の実行環境で実行可能であることを検証するため、
bare command(`codex`)や `./codex` 等の相対 path、未解決のまま deploy すると
失敗する(fail-closed)。無効 provider の CLI は対象外。

unit内の`SOURCE_ID`はtokenのsourceIdと一致させる必要はない。Hubは認証tokenに紐付くsourceIdを保存時の基準として使う。
`COLLECTOR_INTERVAL_SECONDS=60` で常駐送信、`0` なら oneshot(1 回送信して終了)。
oneshot は成功時 0 終了で終わるため、collector unit は `Restart=on-failure`
(常駐でもクラッシュ時のみ再試行。`Restart=always` にすると oneshot の「1 回だけ」
が壊れるため使わない)。

### 4. Dashboard の配信(Node.js service)

Dashboard は `limit-monitor-dashboard.service` が `packages/client/dist/public` を直接配信する。
nginx は不要。`HOST=127.0.0.1` / `PORT=8788` は `deploy/dashboard.env.example` と一致させておく。
ブラウザがアクセスする origin と bind address は分離している。LAN bind
(`HOST=0.0.0.0` 等)にする場合は `dashboard.env` の `DASHBOARD_PUBLIC_ORIGIN` に
ブラウザが実際に送る origin を設定し、`deploy/hub.env.example` の
`CORS_ALLOWED_ORIGINS` もその値に更新する。`deploy/deploy.sh --install-systemd`
はこの不整合を黙って作らず、LAN bind で `DASHBOARD_PUBLIC_ORIGIN` 未設定や
CORS origin の不一致があれば止まる(fail-closed)。
localhost 既定 bind (`HOST=127.0.0.1`) の場合は `DASHBOARD_PUBLIC_ORIGIN` が
未設定でも deploy.sh が `http://127.0.0.1:8788` を導出するため設定不要。

開発時は Vite 開発サーバーを使う:

```bash
VITE_HUB_BASE_URL=http://127.0.0.1:8787 npm run dev -w dashboard   # http://localhost:5173
```

## Collector の収集経路(real mode)

`COLLECTOR_MODE` の既定は `real`。fixture の送信は `COLLECTOR_MODE=mock` を
**明示した場合だけ**行われる。未知の値(`fixture` など)は起動時に落ちる。

| provider | 取得経路 |
| --- | --- |
| `claude` | `claude -p "/usage" --output-format json` を実行し、`result` 本文の `Current session:` / `Current week (...)` 行を parse する |
| `codex` | `codex app-server` を stdio で起動し、`initialize` → `initialized` → `account/rateLimits/read` を 1 回だけ呼ぶ |

どちらも:

- 有限 timeout(`COLLECTOR_COMMAND_TIMEOUT_MS`、既定 60 秒)で必ず回収する
- stdout 上限(`COLLECTOR_MAX_STDOUT_BYTES`、既定 1MiB)を超えたら失敗にする
- 非 0 終了・signal 終了・spawn 失敗をすべて失敗として扱う
- 取得できなければ**失敗として扱い、fixture や既定値へ fallback しない**

Claude 側は `/usage` 本文のうち rate limit 行だけを読み、利用内訳(skill 名・
subagent 名・session 数)や transcript・認証ファイルは読まない。
Codex 側は応答のうち `limitId` / `usedPercent` / `windowDurationMins` / `resetsAt` だけを
採り、`credits` / `planType` / `balance` は Hub へ送らない。

### 取得失敗時の扱い

- 失敗した provider については**何も送信しない**ため、Hub 側の古い値は消えない
  (Dashboard では時間経過に応じて `stale` / `expired` になる)
- ただし失敗を無条件に成功扱いにはしない:

| 状況 | 挙動 |
| --- | --- |
| provider が 1 つも設定されていない | 非 0 終了 |
| 全 provider が失敗 | 非 0 終了(常駐でも起動しない。systemd が `RestartSec` で再試行) |
| 一部失敗 + oneshot(`COLLECTOR_INTERVAL_SECONDS=0`) | 非 0 終了 |
| 一部失敗 + 常駐 | error ログを出して常駐を継続(一時障害で落とさない) |
| 常駐中のサイクルで失敗 | error ログを出して次のサイクルへ |

送信できなかった場合(Hub 停止・401 など)もそのサイクルは失敗として数える。

## アップグレード

```bash
git pull
sudo ./deploy.ts --hub-base-url <url> --server --collector  # 全サービス
```

既存の旧unit名(`limit-hub` / `limit-dashboard` / `limit-collector`)から移行する場合は、
新unitを起動する前に旧unitを停止・disableする:

```bash
sudo systemctl disable --now limit-hub limit-dashboard limit-collector
sudo systemctl daemon-reload
```

旧unitが存在しない場合のエラーは無視してよい。旧unitが停止済みであることを確認してから、
上記の新名称のdeployを実行する。


`package.json` の `version` を更新してから再度 `--prepare-build` と deploy を実行する。過去 version は `KEEP_VERSIONS` 件まで残るため、切り戻しは symlink を戻して再起動する:

```bash
sudo ln -sfn /var/www/limit-monitor/versions/<前の version> /var/www/limit-monitor/.current.new
sudo mv -T /var/www/limit-monitor/.current.new /var/www/limit-monitor/current
sudo systemctl restart limit-monitor-hub limit-monitor-collector
```

DB migration は前方向のみのため、schema 変更を含む release からの切り戻しは
バックアップからのリストアが必要になる。

## バックアップ / リストア

SQLite は WAL mode のため、稼働中のバックアップには sqlite3 の `.backup` を使う:

```bash
sqlite3 /var/lib/limit-monitor/limit-monitor.sqlite ".backup /var/backups/limit-monitor.sqlite"
```

リストアは Hub 停止 → ファイル差し替え → 起動。

## ログ

```bash
journalctl -u limit-monitor-hub -f
journalctl -u limit-monitor-collector -f
```

- 構造化(JSON)ログ。access ログには requestId / method / path / status / duration が入る
- token、vendor response 全文、認証情報はログへ出力しない。vendor CLI の失敗は
  exit code / signal / byte 数などの metadata だけを出し、stdout / stderr の内容は載せない
- `/healthz` で version と schemaVersion を確認できる

## トラブルシュート

| 症状 | 確認 |
| --- | --- |
| `readyz` が 503 | DB ファイルの権限、`StateDirectory` / `ReadWritePaths` の設定 |
| ingest が 401 | token の失効状態(`tokens.ts list`)、Bearer header |
| ingest が 403 | tokenが無効/失効、またはpayloadの`accountAlias`がtokenと不一致の場合。`sourceId`の不一致はHub側でtokenの値へ正規化される |
| ingest が 400 | `observedAt` が Hub 時刻より 5 分以上未来でないか(clock skew) |
| ingest が 429 | 送信間隔(rate limit: sourceId ごと 120 req/分) |
| Dashboard が OFFLINE | Hub の稼働、build 時の `VITE_HUB_BASE_URL` |
| Dashboard から fetch が CORS エラー | Hub の `CORS_ALLOWED_ORIGINS` に Dashboard の public origin(LAN bind は `DASHBOARD_PUBLIC_ORIGIN`、localhost 既定 bind は `http://127.0.0.1:8788`)が含まれているか |
| collector が `spawn_failed` | `CODEX_BIN` / `CLAUDE_BIN` の絶対 path(deploy で install user の実行環境で検証済みのはず)、実行ユーザーの権限 |
| collector が `exit_failure` | 実行ユーザーで `codex`/`claude` に login 済みか。`ProtectHome=false` になっているか |
| collector が `app_server_error` | `codex login status`。`detail` に app-server のエラー文言が出る |
| collector が `cli_error` / `no_rate_limits` | `claude -p "/usage" --output-format json` を実行ユーザーで手動実行して出力を確認する |
| collector が `timeout` | `COLLECTOR_COMMAND_TIMEOUT_MS` を延ばす。CLI の cold start が遅いホストで起きる |
| collector が起動直後に落ちる | `COLLECTOR_MODE` の値(`real` / `mock` 以外は失敗)、`COLLECTOR_PROVIDERS` の provider 名 |
| Dashboard に古い値が残る | 該当 provider の収集が失敗している(古い値は意図的に消さない)。`freshness` と collector のログを確認する |

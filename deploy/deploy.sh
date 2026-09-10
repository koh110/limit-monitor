#!/usr/bin/env bash
#--usage-begin
# limit-monitor の release / systemd 反映を行う内部実装 script。
# OSS 利用者向けの正規入口はリポジトリ root の ./deploy.ts で、対象サービスを
# 明示的に渡してこの script へ委譲する。直接実行してもよい(その場合も
# --services で対象サービスを明示すること)。
#
#   versions/<package.json version>/   ... build 済み artifact + 本番依存のみの node_modules
#   current -> versions/<package.json version>  ... systemd unit が参照する symlink(切替は atomic)
#
# 対象サービス(--services、既定 server,collector):
#   server    ... limit-monitor-hub.service + limit-monitor-dashboard.service
#   collector ... limit-monitor-collector.service
#
# service 実行ユーザーは「install を実行した通常ユーザー」に統一する。
# limit-monitor 専用の Linux user は作らないし前提にもしない。実行ユーザーの
# 指定は利用者へ求めず(option / 環境変数ともに無い)、自動で解決する:
#   1) sudo 経由なら SUDO_USER(root 以外の実ユーザー)と、その primary group
#   2) 非 root 実行なら現在のユーザーと、その primary group
#   3) root 直接で主体が不明なら fail-closed(die)
# uid 0 のユーザーは service 実行ユーザーとして受理しない。
#
# 使い方(clean checkout: まず非 root の --prepare-build、その後に root 実行):
#   VITE_HUB_BASE_URL=... deploy/deploy.sh --prepare-build
#   sudo deploy/deploy.sh --hub-base-url <url> --install-systemd --services server,collector
#   sudo deploy/deploy.sh --hub-base-url <url> --force --install-systemd --services server,collector
#   VITE_HUB_BASE_URL=... deploy/deploy.sh --install-dir /srv/limit-monitor --restart
#
# clean checkout では build artifacts / node_modules / build manifest が未生成、
# または stale(source / lockfile / artifact / VITE_HUB_BASE_URL / production digest
# 不一致)なら、--install-systemd は SUDO_USER(呼び出し元ユーザー)として
# --prepare-build を一度だけ再実行して生成し、以降の検証は root で行う(npm は
# 決して root で実行しない)。SUDO_USER の無い root シェルでは fail-closed で
# die し、先に --prepare-build を実行するよう指示する。
#
# 設定は環境変数(または deploy/deploy.env)で与える。不確実な状態では
# 何も置き換えずに終了する fail-closed 方針。
#--usage-end
#
# --install-systemd はまず全ての内容検証(読み取り専用)を完了してから
# 配置フェーズ(systemd unit / env file / state dir の書き込み)に入る。
# 対象検証: rendered unit / systemd-analyze verify / 既存 unit の
# 管理・非管理 upgrade 判定 / env の INSTALL_DIR 整合 / state dir owner mode /
# collector token / token credential 配線 / vendor CLI / CORS / production 依存
# manifest 検証。いずれか検証失敗時は /etc への書き込み(current symlink 切替を
# 含む)を一切行わない。root 経路では node_modules の全体コピー(cp -aL)をせず、
# 既存 node_modules から production-only tree を作る(build_staged_production_node_modules)。
# release へ入るのは production dependencies のみで、manifest による digest
# 検証(verify_staged_production_tree)を通過したもののみ。
set -euo pipefail

log() { printf '[deploy] %s\n' "$*" >&2; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

# --help: ファイル冒頭の usage block(marker 間)をそのまま出す。
# 行番号を固定しないので、header を編集しても help がずれない。
print_usage() {
  awk '/^#--usage-begin$/ { flag = 1; next } /^#--usage-end$/ { exit } flag' "${BASH_SOURCE[0]}"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
LIMIT_MONITOR_ETC_DIR="/etc/limit-monitor"
# service 実行ユーザー / group。固定値は持たず resolve_install_identity が
# 「install を実行した通常ユーザー」から解決して代入する(fail-closed)。
INSTALL_USER=""
INSTALL_GROUP=""
# deploy 時に解決した実際の node path(command -v node)。render 済み unit の
# ExecStart に注入する(固定の /usr/bin/node は実環境に無いことがある)
DEPLOY_NODE_BIN=""
# render 済み unit の一時ディレクトリ(/etc/systemd/system に入る本体)
RENDERED_SYSTEMD_DIR=""
# --force で既存 version directory を退避した場合の rollback path。配置処理が
# 失敗した EXIT 時は旧 directory を同じ path へ復元し、成功時だけ削除する。
VERSION_BACKUP_DIR=""

# deploy.env があれば読み込む。呼び出し元の環境変数を優先し、deploy.env の値は
# 未設定の変数にだけ適用する(source だとファイル側が上書きしてしまうため)。
if [[ -f "${REPO_ROOT}/deploy/deploy.env" ]]; then
  # shellcheck source=deploy/load-env.sh
  source "${REPO_ROOT}/deploy/load-env.sh"
  log "loading deploy/deploy.env (caller environment wins)"
  load_env_file "${REPO_ROOT}/deploy/deploy.env"
fi

# 旧仕様(collector だけ別ユーザー、または limit-monitor 専用ユーザー)の入力は
# 黙って無視せず fail-closed で拒否する。service 実行ユーザーは自動解決した
# install user へ統一したため、設定されたままだと利用者の意図と実際の実行
# ユーザーが食い違う。deploy.env に残っている場合も同様に止める。
[[ -z "${COLLECTOR_USER:-}" ]] \
  || die "COLLECTOR_USER is no longer supported; all services run as the user that ran the install (resolved from SUDO_USER / the current user). Remove it from the environment and deploy/deploy.env"
[[ -z "${COLLECTOR_GROUP:-}" ]] \
  || die "COLLECTOR_GROUP is no longer supported; all services run as the primary group of the user that ran the install. Remove it from the environment and deploy/deploy.env"
[[ -z "${LIMIT_MONITOR_INSTALL_USER:-}" ]] \
  || die "LIMIT_MONITOR_INSTALL_USER is no longer supported; the install user is resolved automatically (SUDO_USER / the current user). Remove it from the environment and deploy/deploy.env"
[[ -z "${LIMIT_MONITOR_INSTALL_GROUP:-}" ]] \
  || die "LIMIT_MONITOR_INSTALL_GROUP is no longer supported; the install group is the primary group of the resolved install user. Remove it from the environment and deploy/deploy.env"

# 対象サービスの選択(--services)。既定は server(hub + dashboard)と collector の両方。
DEPLOY_SERVICES="${DEPLOY_SERVICES:-server,collector}"
# deploy option 由来の collector provider。空なら collector.env を使う。
DEPLOY_COLLECTOR_PROVIDERS="${DEPLOY_COLLECTOR_PROVIDERS:-}"
DEPLOY_COLLECTOR_PROVIDERS_ARG_SEEN=0
INSTALL_SERVER=0
INSTALL_COLLECTOR=0

INSTALL_DIR="${INSTALL_DIR:-/var/www/limit-monitor}"
KEEP_VERSIONS="${KEEP_VERSIONS:-5}"
FORCE_VERSION="${FORCE_VERSION:-0}"
DEPLOY_RESTART="${DEPLOY_RESTART:-0}"
DEPLOY_INSTALL_SYSTEMD="${DEPLOY_INSTALL_SYSTEMD:-0}"
DEPLOY_PREPARE_BUILD="${DEPLOY_PREPARE_BUILD:-0}"
# 内部フラグ(呼び出し元が設定すべきものではない): root 経路が SUDO_USER として
# --prepare-build を再実行した後の re-prepare 再入を妨げる再帰 loop 防止。
# runuser 子プロセスへ継承されるが、子は --prepare-build 経路で root build
# セクション(このフラグを読む箇所)に到達しないため無害
LIMIT_MONITOR_PREPARE_RETRY="${LIMIT_MONITOR_PREPARE_RETRY:-0}"
SKIP_NPM_CI="${SKIP_NPM_CI:-0}"
HUB_SERVICE="${HUB_SERVICE:-limit-monitor-hub}"
COLLECTOR_SERVICE="${COLLECTOR_SERVICE:-limit-monitor-collector}"
DASHBOARD_SERVICE="${DASHBOARD_SERVICE:-limit-monitor-dashboard}"

# カスタム service 名は unit 名 / 依存関係(After=/Wants=)と連動できないため
# 非既定値は事前拒否する(fail-closed、Major 4)。既定名で運用すること。
[[ "${HUB_SERVICE}" == "limit-monitor-hub" ]] \
  || die "HUB_SERVICE must be the default 'limit-monitor-hub' (got: ${HUB_SERVICE}); custom service names are not supported"
[[ "${COLLECTOR_SERVICE}" == "limit-monitor-collector" ]] \
  || die "COLLECTOR_SERVICE must be the default 'limit-monitor-collector' (got: ${COLLECTOR_SERVICE}); custom service names are not supported"
[[ "${DASHBOARD_SERVICE}" == "limit-monitor-dashboard" ]] \
  || die "DASHBOARD_SERVICE must be the default 'limit-monitor-dashboard' (got: ${DASHBOARD_SERVICE}); custom service names are not supported"

trim_leading_space() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  printf '%s' "$value"
}

read_env_value() {
  local file="$1"
  local key="$2"
  local default="${3:-}"
  local line trimmed

  if [[ ! -f "$file" ]]; then
    printf '%s' "$default"
    return 0
  fi

  # 改行なし最終行も読み込む(read が非ゼロ終了しても line が空でなければ 1 回処理する)
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim_leading_space "$line")"
    [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]] && continue
    case "$trimmed" in
      "$key="*)
        printf '%s' "${trimmed#*=}"
        return 0
        ;;
    esac
  done < "$file"

  printf '%s' "$default"
}

# env file 内の duplicate key を検出する(1 key 1 値の保証)。**読み取り専用**。
# read_env_value は初出の値を返すが、systemd の EnvironmentFile は最後勝ち
# (last-wins)なので、重複 key があると検証で使う値と実行時に効く値が
# 食い違う。collector.env / hub.env / dashboard.env を読む systemd install
# 検証の最初に確認し、重複があれば呼び出し側で die する。
# 重複 key 名を stdout で出して 0 終了; 重複なし(またはファイル不存在)は 1 終了
env_file_has_duplicate_keys() {
  local file="$1"
  local line trimmed key
  local -A seen=()

  [[ -f "$file" ]] || return 1

  # 改行なし最終行も読み込む(最終行が重複 key だと見逃してしまうため)
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim_leading_space "$line")"
    [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]] && continue
    [[ "$trimmed" == *=* ]] || continue
    key="${trimmed%%=*}"
    if [[ -n "${seen[$key]:-}" ]]; then
      printf '%s' "$key"
      return 0
    fi
    seen["$key"]=1
  done < "$file"
  return 1
}

install_if_missing_or_same() {
  local src="$1"
  local dest="$2"
  local mode="$3"
  local owner="${4:-}"
  local group="${5:-}"

  if [[ -e "$dest" ]]; then
    # 既存ファイルは上書きしない。render 済み内容と一致するかを cmp で確認する
    cmp -s "$src" "$dest" || die "refusing to overwrite existing ${dest}; reconcile it manually"
    log "verified existing ${dest}"
    return 0
  fi

  # owner/group を与えた場合のみ新規作成時に所有権を設定する
  if [[ -n "$owner" && -n "$group" ]]; then
    install -D -o "$owner" -g "$group" -m "$mode" "$src" "$dest"
  else
    install -D -m "$mode" "$src" "$dest"
  fi
  log "installed ${dest}"
}

# 対象サービス(--services)を解決する。**読み取り専用**。
# 受理する要素は server(hub + dashboard)と collector のみ。空・未知・重複は
# fail-closed で die する(誤記を「何も選ばれていない」として黙って通さない)。
resolve_selected_services() {
  local raw="${DEPLOY_SERVICES}"
  local element
  local -a parts=()
  local -A seen=()

  [[ -n "$(trim_space "${raw}")" ]] \
    || die "--services must not be empty (choose from: server, collector)"

  # 末尾カンマ由来の空要素も検出したいので手動で分割する
  local trailing_empty=0
  if [[ "${raw}" == *, ]]; then
    raw="${raw%,}"
    trailing_empty=1
  fi
  while [[ -n "${raw}" ]]; do
    case "${raw}" in
      *,*) parts+=("${raw%%,*}"); raw="${raw#*,}" ;;
      *) parts+=("${raw}"); raw="" ;;
    esac
  done
  if [[ "${trailing_empty}" -eq 1 ]]; then
    parts+=("")
  fi

  for element in "${parts[@]}"; do
    element="$(trim_space "${element}")"
    [[ -n "${element}" ]] \
      || die "--services has an empty element (got: ${DEPLOY_SERVICES}); remove blank entries between commas"
    [[ -z "${seen[${element}]:-}" ]] \
      || die "--services has a duplicate entry '${element}' (got: ${DEPLOY_SERVICES})"
    seen["${element}"]=1
    case "${element}" in
      server) INSTALL_SERVER=1 ;;
      collector) INSTALL_COLLECTOR=1 ;;
      *) die "--services has an unknown target '${element}' (allowed: server, collector)" ;;
    esac
  done

  [[ "${INSTALL_SERVER}" -eq 1 || "${INSTALL_COLLECTOR}" -eq 1 ]] \
    || die "--services selected no target (choose from: server, collector)"
}

# 選択された service の unit template 名を stdout へ 1 行ずつ出す。**読み取り専用**。
selected_unit_templates() {
  if [[ "${INSTALL_SERVER}" -eq 1 ]]; then
    printf '%s\n' limit-monitor-hub.service limit-monitor-dashboard.service
  fi
  if [[ "${INSTALL_COLLECTOR}" -eq 1 ]]; then
    printf '%s\n' limit-monitor-collector.service
  fi
}

# systemd unit の User=/Group= として受理できる名前かを判定する。**読み取り専用**。
# 先頭 `-` や空白 / カンマ等の混入した値をそのまま unit や getent へ渡さない。
is_valid_unix_name() {
  local name="$1"
  [[ "${name}" =~ ^[A-Za-z_][A-Za-z0-9_.-]*\$?$ ]]
}

# service 実行ユーザー / group を「install を実行した通常ユーザー」から解決する。
# limit-monitor 専用の Linux user は作らないし前提にもしない(OSS 利用者の
# 環境に固定アカウントを増やさない)。利用者に user / group の指定は求めない。
# 解決順:
#   1) sudo 経由なら SUDO_USER(root 以外の実ユーザー)
#   2) 非 root 実行なら現在のユーザー
#   3) root 直接で主体が不明なら fail-closed(die)
# group は解決したユーザーの primary group(getent passwd / getent group)を使う。
# 検証(すべて満たさなければ die):
#   - user / group 名が unit と getent へ渡せる文字種であること
#   - passwd / group entry が実在すること
#   - uid が 0 でないこと(service を root で走らせない)
#   - home directory が実在する絶対 path であること(vendor CLI が HOME を読む)
# 実効 uid を返す。bash の EUID は readonly で代入できないため、root / 非 root
# の分岐をテストから stub できるよう 1 関数に切り出しておく。
current_euid() {
  printf '%s' "${EUID}"
}

resolve_install_identity() {
  local user="" group="" origin="" entry uid gid home

  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    user="${SUDO_USER}"
    origin="SUDO_USER (invoked through sudo)"
  elif [[ "$(current_euid)" -ne 0 ]]; then
    user="$(id -un)"
    origin="current user"
  else
    die "cannot determine the install user: running as root without SUDO_USER. Re-run through sudo from your normal account (e.g. 'sudo ./deploy.ts --hub-base-url <url> --server --collector'). limit-monitor never creates or assumes a dedicated Linux user, and there is no option to name one"
  fi

  is_valid_unix_name "${user}" \
    || die "install user name is not a valid account name: ${user}"
  entry="$(getent passwd "${user}")" \
    || die "install user not found: ${user} (resolved from ${origin})"
  uid="$(printf '%s\n' "${entry}" | cut -d: -f3)"
  [[ "${uid}" != "0" ]] \
    || die "refusing to run limit-monitor services as uid 0 (${user}, resolved from ${origin}); run the install from a normal (non-root) account through sudo"
  home="$(printf '%s\n' "${entry}" | cut -d: -f6)"
  [[ -n "${home}" && "${home}" == /* && -d "${home}" ]] \
    || die "install user ${user} has no existing absolute home directory (got: ${home}); the codex/claude CLIs read their login state from HOME"

  # primary group は passwd entry の gid から getent group で解決する
  # (利用者に group を指定させない: 主体は install user 側だけで決まる)
  gid="$(printf '%s\n' "${entry}" | cut -d: -f4)"
  [[ -n "${gid}" ]] \
    || die "passwd entry for install user ${user} has no gid; cannot resolve the primary group"
  group="$(getent group "${gid}" | cut -d: -f1)" \
    || die "cannot resolve the primary group (gid ${gid}) of install user ${user}"
  [[ -n "${group}" ]] \
    || die "cannot resolve the primary group (gid ${gid}) of install user ${user}"
  is_valid_unix_name "${group}" \
    || die "install group name is not a valid group name: ${group}"
  # 名前 -> gid の read-back。unit の Group= には名前を書くため、その名前が
  # 元の gid へ戻ることまで確認してから採用する(fail-closed)
  [[ "$(getent group "${group}" | cut -d: -f3)" == "${gid}" ]] \
    || die "install group not found for gid ${gid}: ${group} does not resolve back to the primary group of ${user}"

  INSTALL_USER="${user}"
  INSTALL_GROUP="${group}"
  log "resolved install identity: ${INSTALL_USER}:${INSTALL_GROUP} (from ${origin}); all limit-monitor services run as this account"
}

# state directory の owner / mode を検証する(Minor 6)。**読み取り専用**。
# 既存ディレクトリは hub が書き込むため、解決済み install user:group 所有 +
# mode 755(systemd StateDirectory の既定 0755 と一致)でないと、current 切替後に
# 起動した hub が DB を書けなくなる。
# 不一致は current 切替前に die。存在しない場合は「作成対象」として受理し、
# 配置フェーズ(ensure_systemd_state)で作成する(検証失敗ではない)。
# owner + mode 755 が確定すれば owner の書込は保証されるため、検証フェーズを
# 副作用なし(読み取り専用)に保つため、別途書き込みテストは行わない。
validate_limit_monitor_state_dir() {
  local state_dir="${LIMIT_MONITOR_STATE_DIR:-/var/lib/limit-monitor}"
  if [[ ! -e "$state_dir" ]]; then
    log "state directory ${state_dir} will be created during placement (owner ${INSTALL_USER}:${INSTALL_GROUP}, mode 0755)"
    return 0
  fi
  [[ -d "$state_dir" ]] \
    || die "state path exists but is not a directory: ${state_dir} (current symlink will not be switched)"
  local owner group mode
  owner="$(stat -c '%U' "$state_dir")"
  group="$(stat -c '%G' "$state_dir")"
  mode="$(stat -c '%a' "$state_dir")"
  [[ "$owner" == "${INSTALL_USER}" && "$group" == "${INSTALL_GROUP}" ]] \
    || die "state directory ${state_dir} is owned by ${owner}:${group}, expected ${INSTALL_USER}:${INSTALL_GROUP}; fix ownership before deploying (not switching current)"
  [[ "$mode" == "755" ]] \
    || die "state directory ${state_dir} has mode ${mode}, expected 755; fix mode before deploying (not switching current)"
  log "verified existing state directory: ${state_dir} (owner ${owner}:${group}, mode ${mode})"
}

# 配置フェーズ: etc dir / state dir を用意する(新規のみ作成)。
# ユーザーの作成は一切行わない(install user は既存アカウントを解決したもの)。
# state dir は hub が DB を書く server 側でだけ必要なので、collector 単独
# install では作らない。作成後は owner / mode を read-back して確認する
# (install -d の結果を無検証で信用しない、fail-closed)。
ensure_systemd_state() {
  install -d -m 0755 "${LIMIT_MONITOR_ETC_DIR}"
  [[ "${INSTALL_SERVER}" -eq 1 ]] || return 0
  local state_dir="${LIMIT_MONITOR_STATE_DIR:-/var/lib/limit-monitor}"
  if [[ ! -e "$state_dir" ]]; then
    log "creating state directory: ${state_dir}"
    install -d -o "${INSTALL_USER}" -g "${INSTALL_GROUP}" -m 0755 "$state_dir"
  fi
  local owner group mode
  owner="$(stat -c '%U' "$state_dir")"
  group="$(stat -c '%G' "$state_dir")"
  mode="$(stat -c '%a' "$state_dir")"
  [[ "$owner" == "${INSTALL_USER}" && "$group" == "${INSTALL_GROUP}" && "$mode" == "755" ]] \
    || die "read-back failed: state directory ${state_dir} is ${owner}:${group} mode ${mode}, expected ${INSTALL_USER}:${INSTALL_GROUP} mode 755"
  log "read-back ok: state directory ${state_dir} (owner ${owner}:${group}, mode ${mode})"
}

# deploy.sh が管理する unit へ打つ marker。手編集された(旧)unit と
# 管理対象 unit を区別して、安全な upgrade を判定する(Major 2)
MANAGED_UNIT_MARKER="# limit-monitor: managed by deploy/deploy.sh -- do not edit (edit env instead)"

# 管理対象 unit の install / atomic update(Major 2)。
#   - 新規配置: marker 付きで render 結果を置く
#   - 既存 + 管理対象(marker あり) + 内容一致: そのまま
#   - 既存 + 管理対象(marker あり) + 内容不一致: marker 行を除去した既存を
#     .bak-<ts> へ backup して atomic 更新(mv -T)。手編集リスクを backup で保全
#   - 既存 + 非管理(marker なし): 一律拒否(fail-closed)。
#     手編集された unit の内容が不明なため、上書きしない
# env / token の非上書き保証は install_if_missing_or_same / validate_collector_token
# のままで維持する。
install_managed_unit() {
  local src="$1"
  local dest="$2"
  local mode="$3"
  local rendered managed existing body backup tmp dest_parent

  # render 済み内容に marker を付加して比較・配置に使う
  rendered="${src}.managed"
  {
    printf '%s\n' "${MANAGED_UNIT_MARKER}"
    cat "$src"
  } > "$rendered"

  if [[ ! -e "$dest" ]]; then
    # 新規配置: dest と同じ dir(同じ filesystem)の atomic temp を rename で置く
    # (/tmp 跨ぎは不可、下方の atomic temp 注記を参照)
    dest_parent="$(dirname "$dest")"
    tmp="$(mktemp "${dest_parent}/.limit-unit.XXXXXX")"
    cat "$rendered" > "$tmp"
    chmod "$mode" "$tmp"
    mv -T "$tmp" "$dest"
    log "installed ${dest}"
    rm -f "$rendered"
    return 0
  fi

  managed="$(grep -cF "${MANAGED_UNIT_MARKER}" "$dest" || true)"
  if [[ "$managed" -eq 0 ]]; then
    rm -f "$rendered"
    die "${dest} is not a deploy-managed unit (missing ${MANAGED_UNIT_MARKER##*#} marker); it may be hand-edited. Reconcile it manually (deploy does not overwrite unmanaged units)"
  fi

  # 既存の管理対象 unit。marker を除去した本文同士で cmp する
  # (render 側は marker 付きなので、ここでも marker を除去して比較する)
  existing="$(mktemp "${TMPDIR:-/tmp}/limit-unit-exist.XXXXXX")"
  body="$(mktemp "${TMPDIR:-/tmp}/limit-unit-body.XXXXXX")"
  grep -vF "${MANAGED_UNIT_MARKER}" "$dest" > "$existing"
  grep -vF "${MANAGED_UNIT_MARKER}" "$rendered" > "$body"
  if cmp -s "$body" "$existing"; then
    rm -f "$rendered" "$existing" "$body"
    log "verified existing managed unit ${dest}"
    return 0
  fi

  # 内容不一致: backup を残して atomic に render 結果へ更新する。
  # atomic temp は destination parent と同じ filesystem(例: /etc/systemd/system)で
  # 作る(/tmp 跨ぎは不可)。filesystem を跨ぐ mv は atomic ではなく
  # (copy + unlink)で、中断されると不完全な unit が配置される。
  # 同一 dir への rename(mv -T)は atomic である。
  dest_parent="$(dirname "$dest")"
  tmp="$(mktemp "${dest_parent}/.limit-unit.XXXXXX")"
  cat "$rendered" > "$tmp"
  chmod "$mode" "$tmp"
  rm -f "$existing" "$body"

  backup="${dest}.bak-$(date -u +%Y%m%d%H%M%S)"
  cp -a "$dest" "$backup"
  mv -T "$tmp" "$dest"
  log "updated managed unit ${dest} (previous content backed up to ${backup})"
  rm -f "$rendered"
}

# 管理対象 unit の整合検証(Major 2)。**読み取り専用**で、配置フェーズ前に
# 安全に upgrade できるかを確認する。実際のコピーは install_managed_unit が行う。
#   - 新規( dest 未存在): OK(配置フェーズで install)
#   - 既存 + 管理(marker あり): OK(内容不一致なら配置フェーズで backup + atomic 更新)
#   - 既存 + 非管理(marker なし): 手編集 unit とみなして拒否(die)
check_managed_unit() {
  local src="$1"
  local dest="$2"
  if [[ ! -e "$dest" ]]; then
    log "will install ${dest} (new managed unit)"
    return 0
  fi
  local managed
  managed="$(grep -cF "${MANAGED_UNIT_MARKER}" "$dest" || true)"
  if [[ "$managed" -eq 0 ]]; then
    die "${dest} is not a deploy-managed unit (missing the deploy marker); it may be hand-edited. Reconcile it manually (deploy does not overwrite unmanaged units)"
  fi
  log "verified existing managed unit ${dest} (will update atomically if content differs)"
  return 0
}

dashboard_origin_from_env() {
  local client_env_file="$1"
  local client_host client_port client_origin

  client_host="$(read_env_value "$client_env_file" HOST '127.0.0.1')"
  client_port="$(read_env_value "$client_env_file" PORT '8788')"
  # ブラウザが実際に送る origin は bind address(HOST)ではない。
  # LAN bind(0.0.0.0 等)では DASHBOARD_PUBLIC_ORIGIN を必須にする。
  client_origin="$(read_env_value "$client_env_file" DASHBOARD_PUBLIC_ORIGIN '')"
  if [[ -z "$client_origin" ]]; then
    if [[ "$client_host" == "127.0.0.1" || "$client_host" == "localhost" ]]; then
      client_origin="http://${client_host}:${client_port}"
    else
      die "DASHBOARD_PUBLIC_ORIGIN must be set in ${client_env_file} when HOST=${client_host} (LAN bind); set the browser-facing origin used for CORS"
    fi
  fi
  is_strict_origin "$client_origin" \
    || die "DASHBOARD_PUBLIC_ORIGIN must be an origin (http://host or https://host, optional :port; no path/search/hash/credentials, got: ${client_origin})"
  printf '%s' "$client_origin"
}

# 既存 hub.env を検証用 temporary fileへコピーし、Dashboard originを
# CORS_ALLOWED_ORIGINSへ追加する。secretや他の設定は変更しない。
sync_hub_cors_origin() {
  local source="$1"
  local dest="$2"
  local dashboard_origin="$3"
  local line value origin found=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == CORS_ALLOWED_ORIGINS=* ]]; then
      value="${line#*=}"
      IFS=',' read -r -a origins <<< "$value"
      for origin in "${origins[@]}"; do
        origin="$(trim_space "$origin")"
        if [[ "$origin" == "$dashboard_origin" ]]; then
          found=1
          break
        fi
      done
      if [[ "$found" -eq 0 ]]; then
        value="${value},${dashboard_origin}"
      fi
      line="CORS_ALLOWED_ORIGINS=${value}"
      found=1
    fi
    printf '%s\n' "$line" >> "$dest"
  done < "$source"

  [[ "$found" -eq 1 ]] \
    || die "${source} is missing CORS_ALLOWED_ORIGINS; cannot synchronize dashboard origin"
}

validate_dashboard_cors() {
  # 読み取り専用。$1/$2 で検証対象 env を指定できる(初回は render 済み temp)
  local hub_env_file="${1:-${LIMIT_MONITOR_ETC_DIR}/hub.env}"
  local client_env_file="${2:-${LIMIT_MONITOR_ETC_DIR}/dashboard.env}"
  local client_origin cors_allowed found origin

  client_origin="$(dashboard_origin_from_env "$client_env_file")"
  cors_allowed="$(read_env_value "$hub_env_file" CORS_ALLOWED_ORIGINS '')"

  [[ -n "$cors_allowed" ]] || die "CORS_ALLOWED_ORIGINS is missing from ${hub_env_file}"
  found=0
  IFS=',' read -r -a cors_origins <<< "$cors_allowed"
  for origin in "${cors_origins[@]}"; do
    # Hub 本体(packages/hub/src/config.ts)と一致させる:
    # .split(',').map(o => o.trim()).filter(o => o.length > 0)
    origin="$(trim_space "$origin")"
    if [[ -n "$origin" && "$origin" == "$client_origin" ]]; then
      found=1
      break
    fi
  done
  [[ "$found" -eq 1 ]] || die "${hub_env_file} must allow dashboard origin ${client_origin}"
}

# collector の COLLECTOR_INTERVAL_SECONDS(既定 60)を解決して unit Type を返す:
#   0        -> oneshot (1 回送信して終了; start/restart は実処理終了まで block し、
#               返却後に Result=success / ExecMainStatus=0 が確認できる)
#   >0 / 既定 -> simple  (常駐送信; systemctl start は即 return し is-active=active
#               が確認できる)
# 値は collector.env が優先で、無ければ hub.env をフォールバック(on-disk の
# 既存 env が優先、無いなら render 済み temp、両方無いなら既定 60)。
# interval 値が不正(整数でない / 負)は fail-closed で die する。
collector_unit_type() {
  local file raw
  file="$(env_file_or_rendered "${LIMIT_MONITOR_ETC_DIR}/collector.env" "${RENDERED_ENV_DIR}/collector.env")"
  raw="$(trim_space "$(read_env_value "${file}" "COLLECTOR_INTERVAL_SECONDS" "")")"
  if [[ -z "${raw}" ]]; then
    file="$(env_file_or_rendered "${LIMIT_MONITOR_ETC_DIR}/hub.env" "${RENDERED_ENV_DIR}/hub.env")"
    raw="$(trim_space "$(read_env_value "${file}" "COLLECTOR_INTERVAL_SECONDS" "")")"
  fi
  if [[ -z "${raw}" ]]; then
    raw=60
  fi
  if ! [[ "${raw}" =~ ^[0-9]+$ ]]; then
    die "collector unit Type 解決失敗: COLLECTOR_INTERVAL_SECONDS は 0 以上の整数で設定してください (got: ${raw})"
  fi
  if [[ "${raw}" -eq 0 ]]; then
    printf 'oneshot'
  else
    printf 'simple'
  fi
}

render_unit_from_template() {
  local template="$1"
  local node_bin="$2"
  local out="$3"
  local unit_name
  unit_name="$(basename "$template")"

  # 1) ExecStart の固定 node path を deploy 時の実 path へ
  sed "s|^ExecStart=/usr/bin/node |ExecStart=${node_bin} |" "$template" > "$out"
  # 2) User= / Group= の CHANGE_ME placeholder を解決済み install identity で
  #    置換する。hub / dashboard / collector の 3 unit すべてを同じ
  #    install user:group で動かす(専用 Linux user は作らない)。
  #    template から placeholder 行が失われていたら deploy できないので die する
  local user_lines group_lines
  user_lines="$(grep -c '^User=CHANGE_ME$' "$out" || true)"
  group_lines="$(grep -c '^Group=CHANGE_ME$' "$out" || true)"
  [[ "${user_lines}" -eq 1 && "${group_lines}" -eq 1 ]] \
    || die "${unit_name} must contain exactly one 'User=CHANGE_ME' and one 'Group=CHANGE_ME' line (got User=${user_lines} Group=${group_lines}); fix the unit template"
  sed -i \
    -e "s|^User=CHANGE_ME$|User=${INSTALL_USER}|" \
    -e "s|^Group=CHANGE_ME$|Group=${INSTALL_GROUP}|" \
    "$out"
  # 3) collector unit のみ: COLLECTOR_INTERVAL_SECONDS と Type を整合させる
  #    (既定 60 -> simple / 0 -> oneshot)。template 側の既定 Type=simple は
  #    安全な値のまま保持し、env から render で上書きする。render 後の
  #    Type 妥当性は validate_rendered_units(systemd-analyze verify)で確認する
  if [[ "${unit_name}" == "limit-monitor-collector.service" ]]; then
  local unit_type rendered_type
  # --providers 指定時は EnvironmentFile より後ろに Environment= を追加し、
  # env ファイルを編集せず deploy 時の選択を実効設定として固定する。
  if [[ -n "${DEPLOY_COLLECTOR_PROVIDERS}" ]]; then
    local env_file_line_count
    env_file_line_count="$(grep -c '^EnvironmentFile=-/etc/limit-monitor/collector.env$' "$out" || true)"
    [[ "${env_file_line_count}" -eq 1 ]] \
      || die "${unit_name} must contain exactly one collector EnvironmentFile line to apply --providers (got: ${env_file_line_count})"
    sed -i "/^EnvironmentFile=-\/etc\/limit-monitor\/collector.env$/a Environment=COLLECTOR_PROVIDERS=${DEPLOY_COLLECTOR_PROVIDERS}" "$out"
    grep -qxF "Environment=COLLECTOR_PROVIDERS=${DEPLOY_COLLECTOR_PROVIDERS}" "$out" \
      || die "failed to render collector providers into ${unit_name}"
  fi
  unit_type="$(collector_unit_type)"
  sed -i "s|^Type=.*$|Type=${unit_type}|" "$out"
    # render 済み unit に期待 Type が入ることを read-back で検証(fail-closed)
    rendered_type="$(sed -n 's|^Type=||p' "$out" | head -n1)"
    if [[ "${rendered_type}" != "${unit_type}" ]]; then
      die "rendered ${unit_name} Type is ${rendered_type:-<missing>}, expected ${unit_type} (COLLECTOR_INTERVAL_SECONDS based)"
    fi
  fi
}

validate_rendered_units() {
  local unit_file rendered
  for unit_file in "${RENDERED_SYSTEMD_DIR}"/*.service; do
    rendered="$(basename "$unit_file")"
    # placeholder が残っていれば起動できない。未指定で enable/start しない
    if grep -q '^User=CHANGE_ME$\|^Group=CHANGE_ME$' "$unit_file"; then
      die "${rendered} still contains CHANGE_ME placeholder; the resolved install user/group was not rendered into the unit (run --install-systemd through 'sudo' from your normal account so the install user can be resolved)"
    fi
    # render 後の ExecStart が実際に存在する node path を指しているか
    local node_path
    node_path="$(sed -n 's|^ExecStart=||p' "$unit_file")"
    node_path="${node_path%% *}"
    [[ -x "$node_path" ]] || die "${rendered} ExecStart references missing node binary: ${node_path}"
    # systemd 展開で使われる \$INSTALL_DIR が unit 内に残っているか
    grep -q 'ExecStart=.*\${INSTALL_DIR}' "$unit_file" || die "${rendered} ExecStart lost \${INSTALL_DIR}"
    # systemd がある環境では parse を完了させる。current を切替える前に
    # 壊れた unit を配置しないため、verify 失敗は warning ではなく
    # fail-closed(die)にする(失敗すると current は切替えない)。
    if command -v systemd-analyze >/dev/null 2>&1; then
      systemd-analyze verify "$unit_file" >/dev/null 2>&1 \
        || die "systemd-analyze verify failed for ${rendered} (not switching current)"
    fi
  done
}

# 解決した node path がユーザーの HOME 配下なら current 切替前に fail-closed
# で拒否する(Major 3)。**読み取り専用**。
# hub / dashboard unit は ProtectHome=true なので、HOME 配下
# (/home/<user>/... や /root/...)の node には実行時にアクセス不能であり、
# ExecStart へ注入した path が HOME 配下だと起動できない unit を配置してしまう。
# HOME 外(/usr/local/bin/node / /usr/bin/node 等)の node のみ受理する。
# 判定は引数 path を readlink -f で正規化(実体解決)してから行う:
# HOME 外に置いた symlink の実体が /home/* や /root/* 配下でも拒否する
# (symlink の path 自体だけを見ると見逃してしまうため)
validate_node_bin_not_under_home() {
  local node_bin="$1"
  local real
  # 正規化に失敗した path(存在しない等)は生の path 文字列で判定する。
  # その場合のバイナリ実在保証は validate_rendered_units の -x チェックが担う
  real="$(readlink -f -- "$node_bin" 2>/dev/null)" || real=""
  [[ -n "$real" ]] || real="$node_bin"
  case "$real" in
    /home/*|/root/*)
      die "node path ${node_bin} (resolves to ${real}) is under a user HOME; hub/dashboard units run with ProtectHome=true and cannot access it. Use a node installed outside HOME (e.g. /usr/local/bin/node or /usr/bin/node) before --install-systemd (not switching current)"
      ;;
  esac
  log "verified node bin is outside HOME: ${node_bin} (resolves to ${real})"
}

# DASHBOARD_PUBLIC_ORIGIN を URL として厳密に検証する(client 側の
# isStrictOrigin と同じ URL 集合)。http(s)://host[:port] のみ:
#   - scheme: http / https
#   - host: 非空。userinfo(user:pass@)は host 文字種の @ 除外で拒否
#   - port: 任意、1-65535
#   - pathname: 空のみ(末尾 / は Hub の Origin exact match と不一致になるため拒否)
#   - search(?) / hash(#) は host 文字種の ?# 除外 + 末尾アンカーで拒否
# bash の [[ =~ ]] では ERE を使う。JS の正規表現と一致させる。
is_strict_origin() {
  local value="$1"
  local re='^https?://([^/?#@:]+)(:([0-9]{1,5}))?$'
  if [[ ! "$value" =~ $re ]]; then
    return 1
  fi
  local port="${BASH_REMATCH[3]:-}"
  if [[ -n "$port" ]]; then
    local port_num=$((10#$port))
    if (( port_num < 1 || port_num > 65535 )); then
      return 1
    fi
  fi
  return 0
}

# env file の INSTALL_DIR が deploy 時の INSTALL_DIR と一致するか検証する
# (Major 2)。**読み取り専用**で、配置フェーズ前に現行 env の整合を確認する。
#   - 既存 env: 上書きしない。INSTALL_DIR が deploy 値と一致するなら OK、
#     不一致なら fail-closed(die)
#   - 新規 env(未作成): 配置フェーズで render 例から INSTALL_DIR を deploy 値へ
#     sed して配置するので、ここで失敗させる必要はない(受理)
# render 自体(INSTALL_DIR の sed 置換)と配置は pre-swap ブロックの配置フェーズで行う
validate_env_install_dir() {
  local example="$1"
  local dest="$2"
  local key="INSTALL_DIR"

  if [[ -e "$dest" ]]; then
    local existing
    existing="$(read_env_value "$dest" "$key" "")"
    if [[ "$existing" != "$INSTALL_DIR" ]]; then
      die "${dest} has INSTALL_DIR=${existing} but deploy INSTALL_DIR is ${INSTALL_DIR}; reconcile it (existing env is not overwritten)"
    fi
    log "verified existing ${dest} (INSTALL_DIR=${existing})"
    return 0
  fi
  log "will install ${dest} (new, INSTALL_DIR=${INSTALL_DIR} rendered from example)"
}

# env example を deploy 値で render する(INSTALL_DIR を deploy 値へ置換)。
# 初回(env 未作成)の検証 temp と配置フェーズの env 生成で同じ render を使う。
# example に INSTALL_DIR 行が無くても安全。
render_env_example() {
  local example="$1"
  local out="$2"
  if grep -q '^INSTALL_DIR=' "$example"; then
    # 固定 example の INSTALL_DIR 行を deploy 時の INSTALL_DIR へ上書き。
    # 置換は bash の文字列操作で行う(sedによる置換は使わない): 値内の & / \ /
    # 改行等は sed置換部の metacharacter として解釈されてしまうため
    # (例: INSTALL_DIR=/srv/a&b が "/srv/aINSTALL_DIR=/var/...b" のように壊れる)、
    # 置換経路を通さない。コメント行は ^ anchor 付きで対象外。
    local line rendered
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == INSTALL_DIR=* ]]; then
        rendered="INSTALL_DIR=${INSTALL_DIR}"
      else
        rendered="$line"
      fi
      printf '%s\n' "$rendered" >> "$out"
    done < "$example"
  else
    cp "$example" "$out"
  fi
}

# env file の配置(新規のみ)。既存 env は上書きしない(M2)。
#   - 既存: INSTALL_DIR が deploy 値と一致すれば受理。不一致は fail-closed
#     (検証フェーズの validate_env_install_dir でも die 済みなので二重の
#     保険としてここでも確認する)
#   - 新規: example を render して INSTALL_DIR を deploy 値へ整合させて配置する。
#     第 3 引数(rendered)を与えた場合、その render 済みファイルを**そのまま**
#     配置する(初回 collector.env の CLI path render 分を含む byte-for-byte
#     一致: 検証で通った内容を配置する。固定 example をそのまま配置しない)
ensure_env_install_dir() {
  local example="$1"
  local dest="$2"
  local mode="$3"
  local rendered="${4:-}"
  local existing

  if [[ -e "$dest" ]]; then
    existing="$(read_env_value "$dest" 'INSTALL_DIR' '')"
    [[ "$existing" == "$INSTALL_DIR" ]] \
      || die "${dest} has INSTALL_DIR=${existing} but deploy INSTALL_DIR is ${INSTALL_DIR}; reconcile it (existing env is not overwritten)"
    log "verified existing ${dest} (INSTALL_DIR=${existing}, not overwritten)"
    return 0
  fi

  if [[ -n "$rendered" ]]; then
    # 検証フェーズで render 済みの temp をそのまま配置する(再生成しない)。
    # render_initial_collector_cli_bins 等の追加 render 分を失わない
    install_if_missing_or_same "$rendered" "$dest" "$mode"
    return 0
  fi

  rendered="$(mktemp "${TMPDIR:-/tmp}/limit-env-render.XXXXXX")"
  render_env_example "$example" "$rendered"
  install_if_missing_or_same "$rendered" "$dest" "$mode"
  rm -f "$rendered"
}

# 検証対象 env の解決: on-disk の dest が存在すればそれを使い、存在しなければ
# render 済みの temp(第 2 引数)を使う。初回(env 未作成)でも render 結果を
# 検証できるようにする(読み取り専用)
env_file_or_rendered() {
  local dest="$1"
  local rendered="$2"
  if [[ -e "$dest" ]]; then
    printf '%s' "$dest"
  else
    printf '%s' "$rendered"
  fi
}

# collector-token の検証(Major 5 / Minor 5)。current 切替前に:
#   - symlink でない(通常ファイルのみ。symlink は拒否)
#   - 通常ファイルである(ディレクトリ等は拒否)
#   - root 所有で、mode 600(過剰に緩い permission は拒否)
#   - 空でない(trim 後)
# 既存 token は上書きしない(存在しない場合は die)
validate_collector_token() {
  local token_file="${LIMIT_MONITOR_ETC_DIR}/collector-token"

  [[ -e "$token_file" ]] || die "missing collector token: ${token_file}"
  [[ -L "$token_file" ]] && die "collector token must be a regular file, not a symlink: ${token_file}"
  [[ -f "$token_file" ]] || die "collector token is not a regular file: ${token_file}"

  local content
  content="$(cat "$token_file")"
  content="${content#"${content%%[![:space:]]*}"}"
  content="${content%"${content##*[![:space:]]}"}"
  [[ -n "$content" ]] || die "collector token is empty (or whitespace only): ${token_file}"

  # mode を先に検証する: root 以外が作成した token は mode 600 未達成で
  # まずここで拒否され、root 所有の token も過剰に緩い permission を拒否する
  local perm owner expected_owner
  perm="$(stat -c '%a' "$token_file")"
  owner="$(stat -c '%U' "$token_file")"
  [[ "$perm" == "600" ]] \
    || die "collector token mode is too-permissive: ${perm} (expected 600, owner: ${owner}): ${token_file}"
  # 本番では --install-systemd が root 前提(EUID=0 を事前検証で強制)なので
  # token は root 所有のみ受理する。非 root 環境(テスト等)では現在ユーザー
  # 自身の所有のみ受理する(root 以外の他ユーザー所有の token はどちらの
  # 環境でも拒否する)
  if [[ "${EUID}" -eq 0 ]]; then
    expected_owner="root"
  else
    expected_owner="$(id -un)"
  fi
  [[ "$owner" == "$expected_owner" ]] \
    || die "collector token must be owned by ${expected_owner} (owned by: ${owner}): ${token_file}"
  log "verified collector token: ${token_file} (mode ${perm}, owner ${owner})"
}

# collector-token を「service user が LoadCredential で読める」形で unit へ
# 配線できているかを検証する(Major)。**読み取り専用**。
# token file 自体は root:root mode 600 の安全境界を維持する: systemd(PID 1 =
# root)が credential を読み、unit ごとの credential directory へ service user
# 所有・mode 0400 で複製するため、service user に token file 自体の read 権限は
# 不要であり、与えてもいけない。よって検証するのは「配線」であって token file の
# 直接 read 可否ではない:
#   - render 済み collector unit が検証済み token path を LoadCredential で読む
#   - HUB_TOKEN_FILE が systemd の credential directory(%d)を指す
#   - credential を読む root 自身が token file を読める
# $1 = render 済み collector unit の path
validate_collector_credential_wiring() {
  local unit_file="$1"
  local token_file="${LIMIT_MONITOR_ETC_DIR}/collector-token"

  grep -qxF "LoadCredential=hub-token:${token_file}" "$unit_file" \
    || die "rendered collector unit must load the token through systemd credentials (expected 'LoadCredential=hub-token:${token_file}'); the service user must not need read access to the token file itself"
  grep -qxF 'Environment=HUB_TOKEN_FILE=%d/hub-token' "$unit_file" \
    || die "rendered collector unit must point HUB_TOKEN_FILE at the systemd credential directory (expected 'Environment=HUB_TOKEN_FILE=%d/hub-token')"
  # credential を読むのは systemd(root)。root で読めなければ service user
  # 側の credential も生成されないため、ここで fail-closed にする
  [[ -r "$token_file" ]] \
    || die "collector token is not readable by the credential loader (root): ${token_file}"
  log "verified collector token credential wiring: ${token_file} -> %d/hub-token (readable by systemd as root, exposed to ${INSTALL_USER} as a 0400 credential)"
}

# collector.env の CODEX_BIN / CLAUDE_BIN を INSTALL_USER の実行環境で検証する
# (Major 1)。env の値を未検証のまま --install-systemd へ進めない:
#   - real mode 以外(mock)では vendor CLI を使わないため対象外にできる
#   - COLLECTOR_PROVIDERS で無効な provider の CLI は対象外
#   - 各 CLI は絶対 path として INSTALL_USER 環境で実行可能で存在すること
#     を確認する(systemd 配下は PATH が細い。bare command 名や slash 付き
#     相対 path は PATH 依存・CWD 依存で再現できないため一律に拒否する)
# 戻り値: 0 = 検証通過 / 非ゼロ = 拒否(呼び出し側が die)
resolve_collector_bin_as_user() {
  local bin="$1"
  [[ -n "$bin" ]] || return 1
  # 絶対 path だけ受理。bare command(codex 等)と slash 付き相対 path
  # (./codex、../bin/codex 等)は拒否する: systemd unit の ExecStart は
  # 呼び出し環境の PATH/CWD を信頼しないため、相対値は置いても動かない
  [[ "$bin" == /* ]] || return 1
  runuser -u "${INSTALL_USER}" -- test -x "$bin" 2>/dev/null
}

# 前後の空白を trim する
trim_space() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# $1 = 対象 provider 名、$2 = COLLECTOR_PROVIDERS 値(カンマ区切り)。
# カンマ分割して各要素を trim し、正確に一致するか判定する。
# 旧実装 `[[ ",${providers}" == *,codex,* ]]` では末尾/唯一 provider
# (例: "codex" 単独、"claude,codex")を検出できなかった。
# 未知 provider 名はここでは無視する(collector 本体は起動時に未知名を
# 拒否する: resolveProviders)。
provider_list_has() {
  local wanted="$1"
  local raw="$2"
  local element
  local parts=()
  local IFS=','
  read -r -a parts <<< "$raw"
  for element in "${parts[@]}"; do
    element="$(trim_space "$element")"
    if [[ "$element" == "$wanted" ]]; then
      return 0
    fi
  done
  return 1
}

# provider list を検証・正規化する。CLI option と collector.env の双方で
# 同じ許可集合 / 空要素 / 重複ルールを使う。
normalize_collector_providers() {
  local raw="$1"
  local source="${2:-COLLECTOR_PROVIDERS}"
  local element
  local -a parts=()
  local -a normalized=()
  local -A seen=()

  raw="$(trim_space "$raw")"
  [[ -n "$raw" ]] \
    || die "${source} must list at least one provider (allowed: codex, claude, grok)"
  if [[ "$raw" == *\"* || "$raw" == *\'* ]]; then
    die "${source} must not contain quotes (got: ${raw})"
  fi

  local rest="$raw"
  local trailing_empty=0
  if [[ "$rest" == *, ]]; then
    rest="${rest%,}"
    trailing_empty=1
  fi
  while [[ -n "$rest" ]]; do
    case "$rest" in
      *,*) parts+=("${rest%%,*}"); rest="${rest#*,}" ;;
      *) parts+=("$rest"); rest="" ;;
    esac
  done
  if [[ "$trailing_empty" -eq 1 ]]; then
    parts+=("")
  fi

  for element in "${parts[@]}"; do
    element="$(trim_space "$element")"
    [[ -n "$element" ]] \
      || die "${source} contains an empty provider entry (got: ${raw})"
    case "$element" in
      codex|claude|grok) ;;
      *) die "${source} contains an unknown provider '${element}' (allowed: codex, claude, grok)" ;;
    esac
    [[ -z "${seen[$element]:-}" ]] \
      || die "${source} contains a duplicate provider '${element}' (got: ${raw})"
    seen["$element"]=1
    normalized+=("$element")
  done

  local IFS=','
  printf '%s' "${normalized[*]}"
}

# deploy option が指定されていればそれを実効値とし、未指定なら従来どおり
# collector.env の COLLECTOR_PROVIDERS を使う。
effective_collector_providers() {
  local env_file="$1"
  if [[ -n "${DEPLOY_COLLECTOR_PROVIDERS}" ]]; then
    printf '%s' "${DEPLOY_COLLECTOR_PROVIDERS}"
    return 0
  fi
  read_env_value "$env_file" COLLECTOR_PROVIDERS ''
}

# vendor CLI の path を INSTALL_USER の実行環境で解決する。
#   - 呼び出し元 env(CODEX_BIN / CLAUDE_BIN)に明示値があればそれを優先
#   - 未設定なら INSTALL_USER の login shell 経由で解決:
#     `runuser -u <INSTALL_USER> -- <user_shell> -lc 'command -v -- <cli>'`
#     (systemd 配下は PATH が細いため、ユーザーの login 環境で解決する。
#      `runuser -l USER -- command -v` の形式は禁止: -l だと -- の直後を
#      login shell として扱う処理経路に入り、解決対象 CLI が shell と
#      解釈される(存在しない shell として失敗する)ため、shell を明示して
#      その中に command -v を実行する安全形式へ統一する)
#   - 解決できない(CLI 不在)は非ゼロ終了(呼び出し側が die)
# $1 = 呼び出し元 env の key(CODEX_BIN / CLAUDE_BIN)、$2 = CLI 名(codex / claude)
resolve_collector_cli_path() {
  local env_key="$1"
  local cli="$2"
  local caller_value="${!env_key:-}"
  local user_shell resolved

  if [[ -n "$caller_value" ]]; then
    printf '%s' "$caller_value"
    return 0
  fi

  user_shell="$(getent passwd "${INSTALL_USER}" | cut -d: -f7)"
  [[ -n "$user_shell" ]] || user_shell="/bin/sh"
  resolved="$(runuser -u "${INSTALL_USER}" -- "$user_shell" -lc "command -v -- \"${cli}\"" 2>/dev/null)" \
    || return 1
  [[ -n "$resolved" ]] || return 1
  printf '%s' "$resolved"
}

# 初回 install(collector.env 未作成)用の temp collector.env に、解決済み CLI
# path を render する。example の固定 CODEX_BIN/CLAUDE_BIN(/usr/local/bin/...)
# はそのまま検証してはいけない(実環境に無い path で false failure になる)。
# INSTALL_USER として解決した実際の path を temp env へ render してから
# validate_collector_binaries に渡す。呼び出し元 env の CODEX_BIN/CLAUDE_BIN
# は優先する。CLI 不在は die(fail-closed)。
# $1 = render 済み temp collector.env の path
render_initial_collector_cli_bins() {
  local temp_env="$1"
  local providers codex_path claude_path
  providers="$(normalize_collector_providers "$(effective_collector_providers "$temp_env")" 'collector providers')"

  # 選択された CLI provider だけを解決する。grok はローカル billing log を
  # 読むため vendor CLI path の検証を必要としない。
  if provider_list_has "codex" "$providers"; then
    codex_path="$(resolve_collector_cli_path CODEX_BIN codex)" \
      || die "codex CLI not found in ${INSTALL_USER} environment (resolve: runuser -u ${INSTALL_USER} -- <user_shell> -lc 'command -v -- codex')"
    sed -i "s|^CODEX_BIN=.*|CODEX_BIN=${codex_path}|" "$temp_env"
    log "initial install: rendered resolved Codex CLI path into temp env (CODEX_BIN=${codex_path})"
  fi
  if provider_list_has "claude" "$providers"; then
    claude_path="$(resolve_collector_cli_path CLAUDE_BIN claude)" \
      || die "claude CLI not found in ${INSTALL_USER} environment (resolve: runuser -u ${INSTALL_USER} -- <user_shell> -lc 'command -v -- claude')"
    sed -i "s|^CLAUDE_BIN=.*|CLAUDE_BIN=${claude_path}|" "$temp_env"
    log "initial install: rendered resolved Claude CLI path into temp env (CLAUDE_BIN=${claude_path})"
  fi
}

# $1 = 検証対象の collector env ファイル(on-disk の /etc/limit-monitor/collector.env、
# 初回(未作成)なら render 済みの temp env)。current 切替前に**読み取り専用**で検証する。
# 有効 provider ごとに CLI path が INSTALL_USER 環境で存在・実行可能であることを
# 確認し、未検証(空値・存在しない・不可実行)のまま current を切替えない(Major 1)。
validate_collector_binaries() {
  local env_file="${1:-${LIMIT_MONITOR_ETC_DIR}/collector.env}"
  local mode providers element
  local -a provider_parts=()
  local -A provider_seen=()

  # COLLECTOR_MODE: real/mock のみ受理。typo / 空は fail-closed で die。
  # mock は vendor CLI を使わないため検証をスキップする(既存挙動の維持)。
  mode="$(read_env_value "$env_file" COLLECTOR_MODE 'real')"
  case "$mode" in
    real) ;;
    mock) log "COLLECTOR_MODE=${mode}; skipping vendor CLI validation"; return 0 ;;
    *) die "COLLECTOR_MODE must be 'real' or 'mock' in ${env_file} (got: ${mode})" ;;
  esac

  # COLLECTOR_PROVIDERS: カンマ分割して各要素を trim し、空要素 / 未知 provider
  # (許可は codex, claude のみ) / 重複を die で拒否する。real mode では有効
  # provider が確定していない(空)まま current 切替をしない(fail-closed)。
  #
  # 検証値と systemd(EnvironmentFile)が読む値の一致: read_env_value は引用符を
  # 除去しない(COLLECTOR_PROVIDERS="codex" を "codex"(引用符付き) と読む)。
  # 一方 systemd の EnvironmentFile はダブル / シングル引用符で囲まれた値を
  # 除去して読むため、引用符付き値は検証値と実行時の値が食い違う。parser が
  # 引用符未対応であるため引用符を伴う値は明示 die する(引用符を除去した形
  # へ書き直すこと)。
  providers="$(normalize_collector_providers "$(effective_collector_providers "$env_file")" "collector providers (${env_file})")"
  [[ -n "$providers" ]] \
    || die "collector providers are empty in ${env_file} (allowed: codex, claude, grok)"
  if [[ "$providers" == *\"* || "$providers" == *\'* ]]; then
    die "COLLECTOR_PROVIDERS must not be quoted in ${env_file} (got: ${providers}); remove the quotes: the deploy parser does not strip quotes (systemd does), so the validated value would differ from the systemd value"
  fi

  # カンマ分割(read -r -a は末尾カンマ由来の空要素を落としてしまうため手動で
  # 分割し、末尾カンマの空要素も捕捉する)
  local raw="$providers"
  local trailing_empty=0
  if [[ "$raw" == *, ]]; then
    raw="${raw%,}"
    trailing_empty=1
  fi
  while [[ -n "$raw" ]]; do
    case "$raw" in
      *,*) provider_parts+=("${raw%%,*}"); raw="${raw#*,}" ;;
      *) provider_parts+=("$raw"); raw="" ;;
    esac
  done
  if [[ "$trailing_empty" -eq 1 ]]; then
    provider_parts+=("")
  fi

  for element in "${provider_parts[@]}"; do
    element="$(trim_space "$element")"
    [[ -n "$element" ]] \
      || die "COLLECTOR_PROVIDERS has an empty element in ${env_file} (got: ${providers}); remove blank entries between commas"
    if [[ "$element" != "codex" && "$element" != "claude" && "$element" != "grok" ]]; then
      die "COLLECTOR_PROVIDERS has an unknown provider '${element}' in ${env_file} (allowed: codex, claude, grok)"
    fi
    if [[ -n "${provider_seen[$element]:-}" ]]; then
      die "COLLECTOR_PROVIDERS has a duplicate provider '${element}' in ${env_file} (got: ${providers})"
    fi
    provider_seen["$element"]=1
  done

  local bin
  bin="$(read_env_value "$env_file" CODEX_BIN '')"
  if provider_list_has "codex" "$providers"; then
    # 有効 provider なら path は必須(未検証の空値で起動させない)
    [[ -n "$bin" ]] \
      || die "codex provider is enabled but CODEX_BIN is empty in ${env_file} (set an absolute path resolved as ${INSTALL_USER}: runuser -u ${INSTALL_USER} -- <user_shell> -lc 'command -v -- codex')"
    [[ "$bin" == /* ]] \
      || die "CODEX_BIN must be an absolute path (bare command names and relative paths are not accepted; got: ${bin}). Set it to an absolute path resolved as ${INSTALL_USER}: runuser -u ${INSTALL_USER} -- <user_shell> -lc 'command -v -- codex'"
    resolve_collector_bin_as_user "$bin" \
      || die "CODEX_BIN is not an executable in the ${INSTALL_USER} environment: ${bin} (set an absolute path resolved as ${INSTALL_USER}: runuser -u ${INSTALL_USER} -- <user_shell> -lc 'command -v -- codex')"
    log "verified codex CLI for ${INSTALL_USER}: ${bin}"
  fi

  bin="$(read_env_value "$env_file" CLAUDE_BIN '')"
  if provider_list_has "claude" "$providers"; then
    [[ -n "$bin" ]] \
      || die "claude provider is enabled but CLAUDE_BIN is empty in ${env_file} (set an absolute path resolved as ${INSTALL_USER}: runuser -u ${INSTALL_USER} -- <user_shell> -lc 'command -v -- claude')"
    [[ "$bin" == /* ]] \
      || die "CLAUDE_BIN must be an absolute path (bare command names and relative paths are not accepted; got: ${bin}). Set it to an absolute path resolved as ${INSTALL_USER}: runuser -u ${INSTALL_USER} -- <user_shell> -lc 'command -v -- claude'"
    resolve_collector_bin_as_user "$bin" \
      || die "CLAUDE_BIN is not an executable in the ${INSTALL_USER} environment: ${bin} (set an absolute path resolved as ${INSTALL_USER}: runuser -u ${INSTALL_USER} -- <user_shell> -lc 'command -v -- claude')"
    log "verified claude CLI for ${INSTALL_USER}: ${bin}"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --hub-base-url) VITE_HUB_BASE_URL="${2:-}"; shift 2 ;;
    --keep-versions) KEEP_VERSIONS="${2:-}"; shift 2 ;;
    --force) FORCE_VERSION=1; shift ;;
    --restart) DEPLOY_RESTART=1; shift ;;
    --no-restart) DEPLOY_RESTART=0; shift ;;
    --install-systemd) DEPLOY_INSTALL_SYSTEMD=1; DEPLOY_RESTART=1; shift ;;
    --prepare-build) DEPLOY_PREPARE_BUILD=1; shift ;;
    --skip-npm-ci) SKIP_NPM_CI=1; shift ;;
    --services) DEPLOY_SERVICES="${2:-}"; shift 2 ;;
    --providers)
      [[ "${DEPLOY_COLLECTOR_PROVIDERS_ARG_SEEN}" -eq 0 ]] || die "--providers is specified more than once"
      [[ -n "${2:-}" ]] || die "--providers requires a comma-separated list from codex,claude,grok"
      DEPLOY_COLLECTOR_PROVIDERS="${2}"
      DEPLOY_COLLECTOR_PROVIDERS_ARG_SEEN=1
      shift 2
      ;;
    -h|--help) print_usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# --- 事前検証(fail closed) ---------------------------------------------------

# 対象サービスの選択は他の検証より先に確定させる(以降の検証はどの service を
# install するかで分岐するため)。空 / 未知 / 重複は fail-closed
resolve_selected_services
if [[ -n "${DEPLOY_COLLECTOR_PROVIDERS}" ]]; then
  [[ "${INSTALL_COLLECTOR}" -eq 1 ]] || die "--providers requires the collector service to be selected"
  DEPLOY_COLLECTOR_PROVIDERS="$(normalize_collector_providers "${DEPLOY_COLLECTOR_PROVIDERS}" '--providers')"
  log "collector providers selected by deploy option: ${DEPLOY_COLLECTOR_PROVIDERS}"
fi
log "selected services: $(selected_unit_templates | tr '\n' ' ')"

[[ "${INSTALL_DIR}" == /* ]] || die "INSTALL_DIR must be an absolute path (got: ${INSTALL_DIR})"
[[ "${INSTALL_DIR}" != "/" ]] || die "INSTALL_DIR must not be /"
[[ "${KEEP_VERSIONS}" =~ ^[0-9]+$ ]] || die "KEEP_VERSIONS must be a non-negative integer"
[[ "${KEEP_VERSIONS}" -ge 1 ]] || die "KEEP_VERSIONS must be >= 1"

# Dashboard は Hub URL を build 時に焼き込む SPA なので、既定値のまま
# release すると LAN から動かない。明示指定を必須にする。
if [[ -z "${VITE_HUB_BASE_URL:-}" ]]; then
  die "VITE_HUB_BASE_URL is required (baked into the dashboard build at build time)"
fi
[[ "${VITE_HUB_BASE_URL}" =~ ^https?:// ]] || die "VITE_HUB_BASE_URL must start with http:// or https://"

if [[ "${DEPLOY_INSTALL_SYSTEMD}" == "1" ]]; then
  DEPLOY_RESTART=1
fi

for tool in node npm git install ln mv cp cmp getent stat sed runuser sha256sum awk find sort xargs; do
  command -v "${tool}" >/dev/null 2>&1 || die "required tool not found: ${tool}"
done

if [[ "${DEPLOY_INSTALL_SYSTEMD}" == "1" || "${DEPLOY_RESTART}" == "1" ]]; then
  # curl: wait_for_hub_ready は hub 起動後に /readyz を poll して
  # readiness を待つため必須。/etc 配置 / current symlink 切替 /
  # systemd restart の前に事前検証で fail-closed する(通常 build /
  # --prepare-build 経路は不要)
  # useradd / groupadd は要求しない: limit-monitor は Linux user を作らず、
  # install を実行した通常ユーザーをそのまま service 実行ユーザーにする
  for tool in systemctl curl; do
    command -v "${tool}" >/dev/null 2>&1 || die "required tool not found for systemd operations: ${tool}"
  done
  [[ "${EUID}" -eq 0 ]] || die "systemd operations require root (run with sudo)"
fi

if [[ "${DEPLOY_INSTALL_SYSTEMD}" == "1" ]]; then
  # ExecStart へ注入する実 node path を deploy 時に解決する
  DEPLOY_NODE_BIN="$(command -v node)" || die "node not found; cannot render systemd units"
  # ExecStart には正規化済み(実体解決)の path を注入する。
  # 呼び出し元の PATH 由来の path が symlink の場合でも、unit 内は
  # 実体を指す一貫した path になる
  DEPLOY_NODE_BIN="$(readlink -f -- "${DEPLOY_NODE_BIN}")" || die "cannot resolve node path: ${DEPLOY_NODE_BIN}"
  log "resolved node for systemd units: ${DEPLOY_NODE_BIN}"
  # node path が HOME 配下なら ProtectHome=true の hub / dashboard unit から
  # アクセス不能になるため、current 切替前に fail-closed(Major 3)
  validate_node_bin_not_under_home "${DEPLOY_NODE_BIN}"
  # 3 unit すべての User=/Group= になる install identity を解決する。
  # 専用 Linux user は作らず、install を実行した通常ユーザーを使う(利用者に
  # user / group の指定は求めない)。解決できない(root 直接で主体不明)場合は
  # enable/start せず fail-closed
  resolve_install_identity
  [[ -n "${INSTALL_USER}" && -n "${INSTALL_GROUP}" ]] \
    || die "install user/group could not be resolved for --install-systemd"
fi

VERSION_ID="$(node -e '
const fs = require("node:fs")
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const version = typeof pkg.version === "string" ? pkg.version : ""
const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version)
const prerelease = match?.[4]?.split(".") ?? []
const validPrerelease = prerelease.every((part) => !/^[0-9]+$/.test(part) || !part.startsWith("0") || part === "0")
if (!match || !validPrerelease) process.exit(1)
process.stdout.write(version)
' "${REPO_ROOT}/package.json")" \
  || die "package.json version must be valid semver"

# --- build manifest -----------------------------------------------------------
# root は npm ci/build を実行しないため、既存 artifacts が**今回 deploy する
# source と一致する build** であることを、非 root build の直後に生成された
# manifest で保証する(古い Dashboard build を root へ採用しない、fail-closed)。
# manifest: ${REPO_ROOT}/dist/.limit-monitor-build-manifest (key=value)
#   内容: VITE_HUB_BASE_URL / git rev / source digest (git ls-files 各ファイルの
#         現在ディスク内容の sha256、未コミット変更を含む) / package-lock digest /
#         artifact digest (stage_package が release へコピーする全ファイルの
#         deterministic hash: 5 directory trees — packages/{shared,hub}/dist +
#         packages/hub/drizzle + packages/{collector,client}/dist — と root
#         package.json / package-lock.json を path sort で連結。欠損 / 改変は
#         必ず digest 不一致になる) /
#         node_modules_prod_digest (production dependency tree の全 file
#         path+sha256 の digest: package-lock.json の production entries
#         (非 dev / 非 link / top-level node_modules/*) の全ファイルを
#         LC_ALL=C sort で連結し sha256。devDependencies 由来のファイルは
#         対象外) /
#         node_modules_prod_lock_digest (上記 production set を生成した
#         package-lock.json の sha256: production set 自体の改変を検出)
# root 経路は build スキップの直前に必須化し、保存値を現在値と比較する:
# manifest 不在も digest 不一致も die。manifest 生成後に tracked file を
# 変更すると validate が必ず die する。digest の再計算は読み取り専用。
# 非 root 経路は staging で `npm ci --omit=dev` を実行し(prepare_build の
# 通常 `npm ci` と同じく production 依存の lifecycle scripts を実行する。
# 生成条件が一致するため)
# 上記 production set と同じ tree を生成するため、staging tree digest と
# manifest の production digest の一致で「staging へ入るのは production
# dependencies のみ」を検証する(不一致は die)。root 経路も
# build_staged_production_node_modules で production-only tree を作り、
# staging 直前の verify_staged_production_tree で manifest digest の一致を
# 保証した上で配置するため、devDependencies を含む未検証 node_modules を
# そのまま release しない。

BUILD_MANIFEST_FILE="${REPO_ROOT}/dist/.limit-monitor-build-manifest"

sha256_of_file() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  sha256sum "$file" | awk '{print $1}'
}

# source digest: git ls-files で列挙した tracked files の**現在ディスク内容**
# を path + sha256 として連結した digest。git diff HEAD 等の diff 出力に依存
# せず、commit していない変更(例: package-lock の更新)もそのまま取り込む。
# tracked file が 1 つでも変われば digest も変わるため、manifest 生成後に
# tracked file を変更すると validate が必ず die する。REPO_ROOT 自体は digest
# に入れない(path 依存で壊れるため)。
compute_tracked_source_digest() {
  local path h file_count=0 digest=""
  # -z 出力は NUL 区切りだが、bash の $( ) は NUL を落とすため変数経由で
  # 受け取らず、process substitution で直接ループへ流す
  while IFS= read -r -d '' path; do
    [[ -n "${path}" ]] || continue
    # tracked file がディスク上から消えている(未ステージ削除等)場合は
    # 存在しないことを digest に反映する(空内容ではなく削除として)
    if [[ ! -e "${REPO_ROOT}/${path}" ]]; then
      h="missing"
    else
      h="$(sha256_of_file "${REPO_ROOT}/${path}")" || return 1
    fi
    digest="${digest}${path}:${h}"$'\n'
    file_count=$((file_count + 1))
  done < <(git -C "${REPO_ROOT}" ls-files -z 2>/dev/null)
  # git が失敗した(非リポジトリ等)場合は ls-files が空になり loop が
  # 回らない。空 digest は無意味なので fail-closed で return 1
  [[ ${file_count} -gt 0 ]] || return 1
  printf '%s' "${digest}" | sha256sum | awk '{print $1}'
}

# tree digest: 指定ディレクトリ配下の全ファイルを relative path + sha256 として
# 並び替えて連結した digest(= release へ stage される artifact の内容全体を
# 表す deterministic な値)。1 ファイルでも増減 / 改変されれば digest が変わる。
# ディレクトリ不在は「不足」として fail-closed(return 1)。symlink は解像せず
# そのままの path で扱う(内容が変われば digest も変わる)。
compute_tree_digest() {
  local dir="$1"
  local entry rel h
  local digest="" file_count=0
  [[ -d "${dir}" ]] || return 1
  while IFS= read -r -d '' entry; do
    rel="${entry#./}"
    if [[ -d "${entry}" && ! -L "${entry}" ]]; then
      continue
    fi
    h="$(sha256_of_file "${entry}")" || return 1
    digest="${digest}${rel}:${h}"$'\n'
    file_count=$((file_count + 1))
  done < <(cd "${dir}" && find . -type f -print0 | LC_ALL=C sort -z)
  [[ ${file_count} -gt 0 ]] || return 1
  printf '%s' "${digest}" | sha256sum | awk '{print $1}'
}

# release へ stage_package がコピーする全 directory tree と root ファイル。
# artifact digest はこの全域(= release へ入る artifact 全体)を hash する。
# Dashboard index.html も packages/client/dist/public/index.html として
# client/dist 配下に含まれる。
# Hub token CLI(bin/tokens.ts)とその runtime import(dist/src/features/tokens/
# store.js 等)は packages/hub/bin と packages/hub/dist に既に含まれるため
# 追加 tree は不要。staging 済み tree での実行検証は REQUIRED_BUILD_ARTIFACTS
# と staged entrypoint チェック(tokens.ts --help)が担う。
STAGED_DIST_DIRS=(
  packages/shared/dist
  packages/hub/dist
  packages/hub/drizzle
  packages/collector/dist
  packages/client/dist
)
# release へ stage する root ファイル(artifact digest の対象)
STAGED_ROOT_FILES=(
  package.json
  package-lock.json
)

# artifact digest: STAGED_DIST_DIRS + STAGED_ROOT_FILES の全ファイルを
# relative path + sha256 として**全体的に LC_ALL=C sort(固定順序)**して連結した
# digest(= stage_package が release へコピーする全ファイルを 1 つの
# deterministic な値で表す)。1 ファイルの増加 / 削除(欠損) / 改変のいずれでも
# digest が変わる。ディレクトリ不在・空・root ファイル欠落は fail-closed
# (return 1)。symlink は解像せずそのままの path で扱う(内容が変われば digest
# も変わる)。注: process substitution 内からの return は呼び出し側へ伝播しない
# ため、欠損チェックは全て関数本体側の前チェックで行う。
compute_artifact_digest() {
  local dir entry h relpath
  local digest="" file_count=0
  for dir in "${STAGED_DIST_DIRS[@]}"; do
    [[ -d "${REPO_ROOT}/${dir}" ]] || return 1
    [[ -n "$(find "${REPO_ROOT}/${dir}" -type f -print -quit 2>/dev/null)" ]] || return 1
  done
  for entry in "${STAGED_ROOT_FILES[@]}"; do
    [[ -f "${REPO_ROOT}/${entry}" ]] || return 1
  done
  while IFS= read -r -d '' entry; do
    h="$(sha256_of_file "${REPO_ROOT}/${entry}")" || return 1
    digest="${digest}${entry}:${h}"$'\n'
    file_count=$((file_count + 1))
  done < <(
    {
      for dir in "${STAGED_DIST_DIRS[@]}"; do
        while IFS= read -r -d '' relpath; do
          printf '%s\0' "${dir}/${relpath#./}"
        done < <(cd "${REPO_ROOT}/${dir}" && find . -type f -print0)
      done
      for entry in "${STAGED_ROOT_FILES[@]}"; do
        printf '%s\0' "${entry}"
      done
    } | LC_ALL=C sort -z
  )
  [[ ${file_count} -gt 0 ]] || return 1
  printf '%s' "${digest}" | sha256sum | awk '{print $1}'
}

# production dependency set: package-lock.json の production entries
# (非 dev / 非 link / top-level node_modules/*) を抽出する。
# `npm ci --omit=dev` が生成する production tree と同じ
# パッケージ集合を表す(非 root staging install と root 経路の manifest
# 検証で共通の基準になる)。lockfile 解析は node で行い、path を
# NUL 区切りで stdout へ出す。
# 戻り値: 0 = 正常 / 非ゼロ = lockfile 不在・node 不在・entries 抽出失敗
# (呼び出し側は fail-closed で die する)
compute_production_set() {
  node -e '
    const fs = require("node:fs");
    const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const pkgs = lock.packages || {};
    const out = [];
    for (const [path, meta] of Object.entries(pkgs)) {
      if (!path || !meta) continue;
      const parts = path.split("/");
      // top-level のみ: node_modules/<name> または node_modules/@scope/<name>
      if (parts[0] !== "node_modules") continue;
      if (parts.length === 3) {
        if (!parts[1].startsWith("@")) continue;
      } else if (parts.length !== 2) {
        continue;
      }
      // devDependencies / workspace link は production tree に含まれない
      if (meta.dev || meta.link) continue;
      out.push(path);
    }
    if (out.length === 0) process.exit(3);
    for (const p of out.sort()) process.stdout.write(p + "\0");
  ' "${REPO_ROOT}/package-lock.json"
}

# production set とは逆の集合: package-lock.json の top-level devDependencies
# (meta.dev && !meta.link) を抽出する。production-only tree を作る際の
# 除外基準・検証(dev-only top-level パッケージが staged tree に漏れていない
# か)で使う。path は NUL 区切りで stdout へ出す。
compute_production_dev_set() {
  node -e '
    const fs = require("node:fs");
    const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const pkgs = lock.packages || {};
    const out = [];
    for (const [path, meta] of Object.entries(pkgs)) {
      if (!path || !meta) continue;
      const parts = path.split("/");
      if (parts[0] !== "node_modules") continue;
      if (parts.length === 3) {
        if (!parts[1].startsWith("@")) continue;
      } else if (parts.length !== 2) {
        continue;
      }
      // devDependencies のみ(workspace link は除く: link は dev ではない)
      if (!meta.dev || meta.link) continue;
      out.push(path);
    }
    for (const p of out.sort()) process.stdout.write(p + "\0");
  ' "${REPO_ROOT}/package-lock.json"
}

# 指定した node_modules ルートにある production tree(= compute_production_set
# で列挙した top-level パッケージの全ファイル)の deterministic digest を算出する。
# relative path + sha256 を**LC_ALL=C sort(固定順序)**で連結し、その digest を
# 出す。1 ファイルの増加 / 削除(欠損) / 改変のいずれでも digest が変わる。
#   - find は**ディレクトリ相対**(cd pkg && find .)で relative path を出す
#     (絶対 path を吐かせる "root/pkg" を使わない: 後で二重 prefix するため)
#   - sha256sum を xargs -0 で**バッチ実行**する(ファイル毎に subprocess を
#     起すと 10k 文件で数分かかるため)。xargs は ARG_MAX 超過時に複数回に
#     自動分割されるが、各ファイルの出力は独立なので全体として deterministic
#   - production set に 1 つ以上のファイルが無い(不足)は fail-closed
# 戻り値: 0 = 正常 / 非ゼロ = production set 抽出失敗・不足・root 不在
# 第1引数: node_modules のルート(相対 path 基準になるディレクトリ)
compute_production_tree_digest_at() {
  local root="$1"
  local -a production_set=()
  if ! mapfile -d '' production_set < <(compute_production_set); then
    return 1
  fi
  [[ ${#production_set[@]} -gt 0 ]] || return 1
  [[ -d "${root}" ]] || return 1
  local lines=""
  if ! lines="$(
    (
      cd "${root}" || exit 1
      for pkg in "${production_set[@]}"; do
        [[ -d "${pkg}" ]] || continue
        ( cd "${pkg}" && find . -type f -print0 ) \
          | sed -z "s|^\\./|${pkg}/|"
      done | LC_ALL=C sort -z \
      | xargs -0 -r sha256sum
    ) | awk '{ print substr($0,67) ":" substr($0,1,64) }'
  )"; then
    return 1
  fi
  [[ -n "${lines}" ]] || return 1
  printf '%s\n' "${lines}" | sha256sum | awk '{print $1}'
}

# REPO_ROOT の production tree(= 非 root build フェーズの node_modules)の
# digest。manifest 保存時に使う(非 root build 直後に呼ばれる)。
compute_production_tree_digest() {
  compute_production_tree_digest_at "${REPO_ROOT}"
}

# workspace package link(node_modules/<name> -> packages/<dir>)を列挙する。
# built code は workspace パッケージを "shared/src/..." 等で import するため、
# release の node_modules に link を配置する必要がある(production set とは
# 別物: link は meta.link=true で compute_production_set に含まれない)。
# lockfile の top-level link:true entries を (name, resolved) のペアとして
# 1 link 2 行(name 行 / resolved 行)で stdout へ出す。
# 戻り値: 0 = 正常 / 非ゼロ = lockfile 不在・node 不在・resolved 欠落
compute_workspace_links() {
  node -e '
    const fs = require("node:fs");
    const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const pkgs = lock.packages || {};
    for (const [path, meta] of Object.entries(pkgs)) {
      if (!path || !meta) continue;
      const parts = path.split("/");
      // top-level のみ: node_modules/<name> または node_modules/@scope/<name>
      if (parts[0] !== "node_modules") continue;
      if (parts.length === 3) {
        if (!parts[1].startsWith("@")) continue;
      } else if (parts.length !== 2) {
        continue;
      }
      if (!meta.link) continue;
      const name = parts[parts.length - 1];
      const resolved = meta.resolved;
      if (!resolved) process.exit(4);
      process.stdout.write(name + "\n" + resolved + "\n");
    }
  ' "${REPO_ROOT}/package-lock.json"
}

# root 経路: 既存 node_modules から **production-only tree** を dst へ作る。
# `cp -aL node_modules` の全体コピー(devDependencies 含む全 dev tree を release
# へ出す)を避け、以下のみを取り込む:
#   - production set(compute_production_set: 非 dev / 非 link / top-level
#     node_modules/*)を cp -a で取り込む(symlink を保持。digest は
#     find -type f で symlink をスキップするため -aL の dereference とは
#     一致しない。production set 配下には symlink が無いことを検証済み)
#   - workspace link(compute_workspace_links): staged packages/<dir> へ
#     **symlink** で配置(import "shared/..." の解決に必要)。実体コピーは
#     packages/<dir>/node_modules の dev 依存を release へ持っていくため使わない
# 除外(dev-only top-level パッケージ・.bin・.package-lock.json 等):
#   production set / workspace link の**列挙に現れないもの**はそのまま取り込まず
#   除外される(= production-only)。
# fail-closed(判定不能 / 除外漏れ):
#   - production set が抽出できない / 空 → die
#   - workspace link が抽出できない / 不正(偶数でなく・空要素) → die
#   - production set / workspace link の 1 つでも node_modules に無い → die
#   - 取り込み後 tree が空 → die
# 引数: <src node_modules> <dst node_modules>
build_staged_production_node_modules() {
  local src="$1"
  local dst="$2"
  [[ -d "${src}" ]] || die "source node_modules not found: ${src}"
  install -d -m 0755 "${dst}"

  local -a production_set=()
  if ! mapfile -d '' production_set < <(compute_production_set); then
    die "cannot compute production dependency set from package-lock.json (fail-closed: node missing or lockfile unreadable)"
  fi
  [[ ${#production_set[@]} -gt 0 ]] \
    || die "production dependency set is empty (fail-closed: package-lock.json declares no production dependencies)"

  local entry rel copied=0 skipped=0
  for entry in "${production_set[@]}"; do
    rel="${entry#node_modules/}"
    # npm ci がこの platform では install しない optional platform binding 等は
    # node_modules に無い。compute_production_tree_digest_at も欠損 package を
    # skip する(= manifest digest と一致させるため)ので、同様に skip する
    if [[ ! -e "${src}/${rel}" ]]; then
      skipped=$((skipped + 1))
      continue
    fi
    # scoped package(@scope/name)は親ディレクトリを先に作る
    if [[ "${rel}" == */* ]]; then
      install -d -m 0755 "${dst}/${rel%/*}"
    fi
    # cp -a(= symlink を保持)でコピー: digest は find -type f で symlink を
    # 対象外にするため、-L(展開)だと dereference した file が digest に加わり
    # 不一致になる。symlink を保持することで staged tree と digest が一致する
    cp -a "${src}/${rel}" "${dst}/${rel}"
    copied=$((copied + 1))
  done
  (( copied > 0 )) \
    || die "no production dependencies copied into staging (fail-closed: node_modules has no production packages present)"
  if (( skipped > 0 )); then
    log "skipped ${skipped} production-set entries absent from node_modules (optional platform bindings)"
  fi

  local ws_output
  if ! ws_output="$(compute_workspace_links)"; then
    die "cannot compute workspace links from package-lock.json (fail-closed: node missing or lockfile unreadable)"
  fi
  local -a ws=()
  if [[ -n "${ws_output}" ]]; then
    mapfile -t ws < <(printf '%s\n' "${ws_output}")
  fi
  if (( ${#ws[@]} % 2 != 0 )); then
    die "workspace links are malformed (fail-closed): ${#ws[@]} entries, expected even"
  fi
  local i name resolved ws_created=0 ws_skipped=0
  for (( i = 0; i < ${#ws[@]}; i += 2 )); do
    name="${ws[i]}"
    resolved="${ws[i + 1]}"
    [[ -n "${name}" && -n "${resolved}" ]] \
      || die "workspace link is incomplete (fail-closed): name=${name:-?} resolved=${resolved:-?}"
    # lockfile には workspace package の name(self-link)が乗るが、npm はそれを
    # 物理的に node_modules へ作らない場合がある(例: client の name=dashboard
    # なのに node_modules/dashboard は無い)。source に無い link は staged tree
    # へも作らない(skip)。実行時解決が壊れる link は後続の
    # "verifying staged entrypoints" node import チェックが fail-closed で
    # 検出する。source にある link だけ staged tree へ反映する
    if [[ ! -e "${src}/${name}" ]]; then
      ws_skipped=$((ws_skipped + 1))
      continue
    fi
    [[ -d "${REPO_ROOT}/${resolved}" ]] \
      || die "workspace link target missing (fail-closed): ${name} -> ${resolved}"
    [[ -d "${STAGE_DIR}/${resolved}" ]] \
      || die "workspace package not staged (fail-closed): ${resolved}"
    ln -sfn "../${resolved}" "${dst}/${name}"
    ws_created=$((ws_created + 1))
  done
  if (( ws_skipped > 0 )); then
    log "skipped ${ws_skipped} lockfile workspace links absent from node_modules (phantom self-links)"
  fi

  [[ -n "$(find "${dst}" -mindepth 1 -print -quit 2>/dev/null)" ]] \
    || die "staged production node_modules is empty (fail-closed)"
}

# staged node_modules の production 部分を検証する(root 経路の production-only
# tree が「manifest で検証済みの production dependency tree」と一致することを
# 保証する)。staging tree を**読み取り専用**で走査し、compute_production_set
# が列挙した production set の各パッケージについて:
#   - staged tree に存在する production パッケージの全 file path+sha256 を
#     manifest の production digest と同じ固定順序(LC_ALL=C sort)で再計算
#   - 再計算 digest が manifest の node_modules_prod_digest と一致するか
#   - production set に 1 つ以上のファイルが無い(不足)は fail-closed
# devDependencies 由来のファイルは production set に含まれないため digest
# 対象外(= 検証は production 部分に限定)。staged tree 自体が production
# のみで構成されること(= dev 混入がないこと)は呼び出し側が保証する
# (root 経路では build_staged_production_node_modules が production-only
# tree を作る)。
# 戻り値: 0 = 正常 / 非ゼロ = production set 抽出失敗・不足・digest 不一致
# 第1引数: staged node_modules のルート / 第2引数: manifest ファイル
verify_staged_production_tree() {
  local staged_root="$1"
  local saved_manifest="$2"
  [[ -d "${staged_root}" ]] || return 1
  # compute_production_tree_digest_at は root を「node_modules を含む親ディレクトリ」
  # として cd してから node_modules/<pkg> を歩く。第1引数は node_modules 自身なので
  # 親(dirname)を渡す(= STAGE_DIR)。空 digest の一致を許さない(fail-closed)。
  local staged_parent staged_digest manifest_prod
  staged_parent="$(dirname "${staged_root}")"
  staged_digest="$(compute_production_tree_digest_at "${staged_parent}")" || return 1
  [[ -n "${staged_digest}" ]] || return 1
  manifest_prod="$(read_env_value "${saved_manifest}" node_modules_prod_digest '')"
  [[ -n "${manifest_prod}" ]] || return 1
  [[ "${staged_digest}" == "${manifest_prod}" ]] || return 1
  log "staged production node_modules verified: digest matches manifest (${staged_root})"
}

write_build_manifest() {
  local source_digest lock_digest node_modules_prod_digest artifact_digest
  source_digest="$(compute_tracked_source_digest)" \
    || die "cannot compute source digest (git repository required): ${REPO_ROOT}"
  lock_digest="$(sha256_of_file "${REPO_ROOT}/package-lock.json")" \
    || die "package-lock.json is missing; cannot write build manifest"
  # release へ stage_package がコピーする全ファイル(5 directory trees +
  # root package.json / package-lock.json)を 1 つの deterministic digest
  # として保存する(欠損 / 改変は必ず digest 不一致になる)
  artifact_digest="$(compute_artifact_digest)" \
    || die "staged artifact is missing or incomplete; build before writing manifest (all of ${STAGED_DIST_DIRS[*]} ${STAGED_ROOT_FILES[*]} must exist)"
  # production dependency tree(全 file path+sha256)の digest と、その
  # production set を生成した package-lock.json の digest を manifest に
  # 固定する(root 経路は build_staged_production_node_modules が production
  # 依存のみで構成される production-only tree を作るため、同一の digest
  # 基準)
  node_modules_prod_digest="$(compute_production_tree_digest)" \
    || die "cannot compute production dependency tree digest (package-lock.json must declare production dependencies and node_modules must contain them); run 'npm ci' as a regular user before writing the manifest"
  install -d -m 0755 "${REPO_ROOT}/dist"
  {
    printf 'schema=4\n'
    printf 'vite_hub_base_url=%s\n' "${VITE_HUB_BASE_URL}"
    printf 'git_rev=%s\n' "$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo nogit)"
    printf 'source_digest=%s\n' "${source_digest}"
    printf 'package_lock_digest=%s\n' "${lock_digest}"
    printf 'artifact_digest=%s\n' "${artifact_digest}"
    printf 'node_modules_prod_digest=%s\n' "${node_modules_prod_digest}"
    printf 'node_modules_prod_lock_digest=%s\n' "${lock_digest}"
  } > "${BUILD_MANIFEST_FILE}"
  log "wrote build manifest: ${BUILD_MANIFEST_FILE}"
}

# manifest の保存値を現在値と比較する(root 経路のみ)。**非 dying コア**:
# manifest 不在 / key 欠落 / 値不一致 を検出した場合のみ非ゼロを返し、
# 一致すれば 0 を返す。die しない(呼び出し側が reprepare 判定を行うため)。
#   - vite_hub_base_url: Dashboard build 時に焼き込んだ Hub URL
#   - source_digest: tracked files の現在ディスク内容(build 後の source 改変)
#   - package_lock_digest: lockfile 改変
#   - artifact_digest: stage_package が release へコピーする全ファイル(5
#     directory trees + root package.json / package-lock.json)を**同じ
#     固定順序(path sort)で再計算**して突き合わせる。欠損 / 改変 /
#     増加分のいずれも必ず不一致になる
#   - node_modules_prod_digest: build_staged_production_node_modules が
#     作る production-only tree と同一基準で再計算し突き合わせる
#     production dependency tree(全 file path+sha256)を**同じ固定順序で
#     再計算**して突き合わせる。node_modules 改変 / 不足 / devDependencies
#     混入のいずれも必ず不一致になる
#   - node_modules_prod_lock_digest: production set を生成した
#     package-lock.json が改変されていないか(production set 自体が変われば
#     digest も変わるため)
check_build_manifest() {
  [[ -f "${BUILD_MANIFEST_FILE}" ]] || return 1

  local saved_hub saved_source saved_lock saved_node_modules saved_node_modules_lock saved_artifact
  saved_hub="$(read_env_value "${BUILD_MANIFEST_FILE}" vite_hub_base_url '')"
  saved_source="$(read_env_value "${BUILD_MANIFEST_FILE}" source_digest '')"
  saved_lock="$(read_env_value "${BUILD_MANIFEST_FILE}" package_lock_digest '')"
  saved_node_modules="$(read_env_value "${BUILD_MANIFEST_FILE}" node_modules_prod_digest '')"
  saved_node_modules_lock="$(read_env_value "${BUILD_MANIFEST_FILE}" node_modules_prod_lock_digest '')"
  saved_artifact="$(read_env_value "${BUILD_MANIFEST_FILE}" artifact_digest '')"

  local current_source current_lock current_node_modules current_node_modules_lock current_artifact
  current_source="$(compute_tracked_source_digest)" || return 1
  current_lock="$(sha256_of_file "${REPO_ROOT}/package-lock.json")" || return 1
  current_node_modules="$(compute_production_tree_digest)" || return 1
  current_node_modules_lock="$(sha256_of_file "${REPO_ROOT}/package-lock.json")" || return 1
  current_artifact="$(compute_artifact_digest)" || return 1

  [[ -n "${saved_hub}" ]] || return 1
  [[ -n "${saved_source}" && -n "${saved_lock}" && -n "${saved_node_modules}" && -n "${saved_node_modules_lock}" && -n "${saved_artifact}" ]] || return 1

  [[ "${saved_hub}" == "${VITE_HUB_BASE_URL}" ]] || return 1
  [[ "${saved_source}" == "${current_source}" ]] || return 1
  [[ "${saved_lock}" == "${current_lock}" ]] || return 1
  [[ "${saved_artifact}" == "${current_artifact}" ]] || return 1
  # production-only tree(全 file path+sha256)を再計算して突き合わせる
  [[ "${saved_node_modules}" == "${current_node_modules}" ]] || return 1
  # production set を生成した package-lock.json が改変されていないか
  [[ "${saved_node_modules_lock}" == "${current_node_modules_lock}" ]] || return 1

  log "build manifest verified: ${BUILD_MANIFEST_FILE} (source / lockfile / staged artifacts / production node_modules digests match current tree)"
  return 0
}

VERSIONS_DIR="${INSTALL_DIR}/versions"
VERSION_DIR="${VERSIONS_DIR}/${VERSION_ID}"
# --prepare-build はbuild artifact / manifestだけを生成する経路であり、version directoryの
# 存在や --force は関係しない。root deployからSUDO_USERとして再実行される場合も、
# ここで既存versionを検証するとprepareへ到達できないため、prepare-onlyではskipする。
if [[ "${DEPLOY_PREPARE_BUILD}" != "1" && ( -e "${VERSION_DIR}" || -L "${VERSION_DIR}" ) ]]; then
  [[ "${FORCE_VERSION}" == "1" ]] \
    || die "version already exists: ${VERSION_DIR} (use --force to replace it explicitly)"
  log "--force enabled: existing version will be replaced: ${VERSION_DIR}"
fi

log "repo:         ${REPO_ROOT}"
log "install dir:  ${INSTALL_DIR}"
log "version:      ${VERSION_ID}"
log "hub base url: ${VITE_HUB_BASE_URL}"

# --prepare-build(非 root のみ): npm ci + 全 workspace build + VITE_HUB_BASE_URL での
# Dashboard build + write_build_manifest を実行して終了。staging / release / systemd
# 処理は一切行わない。root では die(npm は決して root で実行しない)。
# build セクション(下方)より前に定義・完結させる: 単体で build + manifest を生成して
# 終了するため、staging / release / systemd には進まない。
prepare_build() {
  if [[ "${SKIP_NPM_CI}" != "1" ]]; then
    log "npm ci"
    npm ci
  fi

  log "building all workspaces (shared / hub / collector / dashboard)"
  npm run build -w shared
  npm run build -w hub
  npm run build -w collector
  VITE_HUB_BASE_URL="${VITE_HUB_BASE_URL}" npm run build -w dashboard

  # build 直後に manifest を生成する(root 経路の build スキップ検証が使う)
  write_build_manifest
}

# root 経路: SUDO_USER として --prepare-build を再実行する際、root の identity
# 環境(HOME=/root, USER=root, LOGNAME=root 等)を子プロセスへ継承しない。
# -l なし runuser は caller(root) の環境をそのまま通過させるため、
# getent passwd から対象ユーザーの home / shell を解決し、runuser 子環境へ
# 明示的に指定する(fail-closed: 解決不能・home が存在しない絶対 path で
# ない場合は die)。caller 環境は env -i で消さない(VITE_HUB_BASE_URL 等は
# そのまま通過 = 既存 caller env 優先を維持)。上書きするのは identity 系
# (HOME/USER/LOGNAME/SHELL/PATH) のみ。npm は root で実行しない。
resolve_sudo_user_identity() {
  local user="$1"
  local entry home shell
  entry="$(getent passwd "${user}")" \
    || die "cannot resolve passwd entry for ${user}; cannot re-run --prepare-build as ${user}"
  home="$(printf '%s\n' "${entry}" | cut -d: -f6)"
  shell="$(printf '%s\n' "${entry}" | cut -d: -f7)"
  [[ -n "${home}" && "${home}" == /* && -d "${home}" ]] \
    || die "passwd entry for ${user} has no existing absolute home directory (got: ${home}); cannot re-run --prepare-build as ${user}"
  [[ -n "${shell}" ]] || shell="/bin/sh"
  SUDO_USER_HOME="${home}"
  SUDO_USER_SHELL="${shell}"
  # PATH は caller 設定値を優先(= 呼び出し元と同じ node / npm が見える)。
  # 未設定時のみ安全な既定値を明示する
  SUDO_USER_PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
}

if [[ "${DEPLOY_PREPARE_BUILD}" == "1" ]]; then
  [[ "${DEPLOY_INSTALL_SYSTEMD}" != "1" && "${DEPLOY_RESTART}" != "1" ]] \
    || die "--prepare-build は manifest 生成で終了するため --install-systemd / --restart と併用できません(別コマンドで先に実行)"
  [[ "${EUID}" -ne 0 ]] \
    || die "--prepare-build は root では許可されていません(npm は決して root で実行しません): 通常ユーザーで 'deploy/deploy.sh --prepare-build' を実行してから root コマンドを再実行"
  prepare_build
  exit 0
fi

# root(EUID=0)では npm ci / npm build を実行しない(安全境界: npm は決して root で実行しない)。
# clean checkout(= build manifest 未生成)や stale build(manifest と現在 tree が一致しない)
# で `sudo ./deploy.ts --hub-base-url <url> --server --collector` を単一コマンドで成立させるため、下方 build
# セクションの manifest 検証で失敗したとき SUDO_USER(呼び出し元ユーザー)として --prepare-build
# を一度だけ再実行する(子プロセス: npm ci + build + manifest で終了)。再実行後も stale
# のままなら fail-closed で die。SUDO_USER の無い root シェルは fail-closed(下方で
# die し、先に --prepare-build を実行するよう指示する)。

# --- build -------------------------------------------------------------------

cd "${REPO_ROOT}"

# deploy に必要な build artifacts(欠けていれば build が必要とみなす)
REQUIRED_BUILD_ARTIFACTS=(
  packages/shared/dist/src/index.js
  packages/hub/dist/src/index.js
  # Hub token CLI(bin/tokens.ts)の runtime import 先
  packages/hub/dist/src/features/tokens/store.js
  packages/collector/dist/src/index.js
  packages/client/dist/public/index.html
  packages/client/dist/server/index.js
  packages/client/dist/server/static-server.js
)

# root(EUID=0)では npm ci / npm build を実行しない(安全境界: npm は決して root で実行しない)。
#   - 非 root: 従来どおり npm ci + npm build + manifest 生成
#   - root: manifest が stale(不在 / digest 不一致)なら SUDO_USER として
#     --prepare-build を一度だけ再実行し、再検証は fail-closed
if [[ "${EUID}" -eq 0 ]]; then
  # build スキップの直前: 既存 artifacts が現 source と一致する build か
  # manifest で保証する。stale / 不在は SUDO_USER として --prepare-build を
  # 一度だけ再実行(再帰 loop 防止: 内部フラグで再実行経路は 1 回のみ)。
  # 再実行後に再び stale なら fail-closed で die
  if ! check_build_manifest; then
    if [[ -n "${SUDO_USER:-}" && "${LIMIT_MONITOR_PREPARE_RETRY}" != "1" ]]; then
      resolve_sudo_user_identity "${SUDO_USER}"
      log "stale build manifest (missing or digest mismatch): running --prepare-build as ${SUDO_USER} (npm is never run as root)"
      LIMIT_MONITOR_PREPARE_RETRY=1 \
      runuser -u "${SUDO_USER}" -- env \
        HOME="${SUDO_USER_HOME}" \
        USER="${SUDO_USER}" \
        LOGNAME="${SUDO_USER}" \
        SHELL="${SUDO_USER_SHELL}" \
        PATH="${SUDO_USER_PATH}" \
        VITE_HUB_BASE_URL="${VITE_HUB_BASE_URL}" \
        bash "${REPO_ROOT}/deploy/deploy.sh" --prepare-build \
        || die "--prepare-build as ${SUDO_USER} failed; fix and re-run 'sudo ./deploy.ts --hub-base-url <url> --server --collector'"
      if ! check_build_manifest; then
        die "build manifest is still stale after re-running --prepare-build as ${SUDO_USER} (fail-closed: ${BUILD_MANIFEST_FILE}); inspect the source tree / node_modules / VITE_HUB_BASE_URL and re-run 'deploy/deploy.sh --prepare-build' manually"
      fi
    else
      if [[ -n "${SUDO_USER:-}" ]]; then
        die "build manifest is still stale after re-running --prepare-build as ${SUDO_USER} (fail-closed: ${BUILD_MANIFEST_FILE}); inspect the source tree / node_modules / VITE_HUB_BASE_URL and re-run 'deploy/deploy.sh --prepare-build' manually"
      fi
      die "build manifest is missing or stale (source / lockfile / VITE_HUB_BASE_URL / artifact / production digest mismatch): ${BUILD_MANIFEST_FILE}; deploy as root does not run npm ci/build — run the build as a regular user first (deploy as root does not run npm ci/build)"
    fi
  fi
  missing_artifacts=""
  for artifact in "${REQUIRED_BUILD_ARTIFACTS[@]}"; do
    if [[ ! -f "${artifact}" ]]; then
      missing_artifacts="${missing_artifacts}  ${artifact}"$'\n'
    fi
  done
  if [[ -n "${missing_artifacts}" ]]; then
    die "build artifacts are missing and npm ci/build cannot be run as root (build as a regular user first, then re-run):
${missing_artifacts}"
  fi
  if [[ ! -d node_modules ]]; then
    die "node_modules is missing and npm ci cannot be run as root (run 'npm ci' as a regular user first)"
  fi
else
  # 非 root: npm ci + 全 workspace build + Dashboard build + manifest 生成
  if [[ "${SKIP_NPM_CI}" != "1" ]]; then
    log "npm ci"
    npm ci
  fi
  log "building all workspaces (shared / hub / collector / dashboard)"
  npm run build -w shared
  npm run build -w hub
  npm run build -w collector
  VITE_HUB_BASE_URL="${VITE_HUB_BASE_URL}" npm run build -w dashboard
  # build 直後に manifest を生成する(root 経路の build スキップ検証が使う)
  write_build_manifest
fi

for artifact in "${REQUIRED_BUILD_ARTIFACTS[@]}"; do
  [[ -f "${artifact}" ]] || die "build artifact missing: ${artifact}"
done

# --- staging -----------------------------------------------------------------

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/limit-monitor-stage.XXXXXX")"
restore_version_backup() {
  local exit_status="$1"
  if [[ -z "${VERSION_BACKUP_DIR}" ]]; then
    return
  fi
  if [[ "${exit_status}" -eq 0 ]]; then
    rm -rf -- "${VERSION_BACKUP_DIR}"
    VERSION_BACKUP_DIR=""
    return
  fi
  rm -rf -- "${VERSION_DIR}" || true
  if mv -T -- "${VERSION_BACKUP_DIR}" "${VERSION_DIR}"; then
    log "restored previous version after failed --force deployment: ${VERSION_DIR}"
    VERSION_BACKUP_DIR=""
  else
    log "ERROR: failed to restore previous version: ${VERSION_BACKUP_DIR} -> ${VERSION_DIR}"
  fi
}
cleanup() {
  local exit_status="$?"
  restore_version_backup "${exit_status}"
  rm -rf "${STAGE_DIR}"
  return "${exit_status}"
}
trap cleanup EXIT

log "staging artifacts into ${STAGE_DIR}"
install -m 644 package.json package-lock.json "${STAGE_DIR}/"
if [[ -f .npmrc ]]; then
  install -m 644 .npmrc "${STAGE_DIR}/"
fi

stage_package() {
  local pkg="$1"; shift
  install -d "${STAGE_DIR}/packages/${pkg}"
  install -m 644 "packages/${pkg}/package.json" "${STAGE_DIR}/packages/${pkg}/package.json"
  local entry
  for entry in "$@"; do
    [[ -e "packages/${pkg}/${entry}" ]] || die "missing ${pkg}/${entry}"
    cp -a "packages/${pkg}/${entry}" "${STAGE_DIR}/packages/${pkg}/"
  done
}

stage_package shared dist
# bin/ は token 発行と migration の CLI(node の型ストリップで直接実行する)
stage_package hub dist drizzle bin
stage_package collector dist
# dashboard/dist は静的 asset(dist/public)と配信 server(dist/server)の両方を含む
stage_package client dist

install -d "${STAGE_DIR}/deploy"
cp -a deploy/systemd "${STAGE_DIR}/deploy/"
cp -a deploy/hub.env.example deploy/collector.env.example deploy/dashboard.env.example \
  "${STAGE_DIR}/deploy/"

# root では staging へも npm ci を実行しない: 既存の node_modules から
# production-only tree を作る(全 dev tree を release へ出さない)。
# 非 root は従来どおり npm ci --omit=dev
if [[ "${EUID}" -eq 0 ]]; then
  [[ -d node_modules ]] || die "node_modules is missing and npm ci cannot be run as root (run 'npm ci' as a regular user first)"
  log "root: building production-only node_modules into staging (npm ci not run as root)"
  build_staged_production_node_modules node_modules "${STAGE_DIR}/node_modules"
else
  log "installing production dependencies into staging"
  ( cd "${STAGE_DIR}" && npm ci --omit=dev )
fi

# staging 後・release/current 変更前: staged node_modules が「manifest で検証済み
# の production dependency tree」と digest 一致するか検証する(不一致は die)
log "verifying staged production node_modules against the build manifest"
verify_staged_production_tree "${STAGE_DIR}/node_modules" "${BUILD_MANIFEST_FILE}" \
  || die "staged production node_modules does not match the build manifest digest (fail-closed): ${BUILD_MANIFEST_FILE}; rebuild as a regular user"

# 本番依存の解決が実際に通るか staging で確認する(release 後に落とさない)
log "verifying staged entrypoints"
( cd "${STAGE_DIR}" && node --input-type=module -e "
  await import('./packages/shared/dist/src/index.js')
  await import('./packages/hub/dist/src/app.js')
  await import('./packages/collector/dist/src/collect.js')
  // dashboard の配信 server は listen しない module 側だけを import する
  await import('./packages/client/dist/server/static-server.js')
" ) || die "staged entrypoints failed to load"
# Hub token CLI: docs/operations.md の契約通り、staging 済み tree で
# `node --experimental-strip-types packages/hub/bin/tokens.ts` が起動できるか
# --help(DB 接続なし)で検証する(bin/tokens.ts 自体と config.js /
# features/tokens/store.js / lib/database.js の全 import が解決する)
( cd "${STAGE_DIR}" && node --experimental-strip-types packages/hub/bin/tokens.ts --help > /dev/null ) \
  || die "staged token CLI entrypoint failed to run (packages/hub/bin/tokens.ts)"

# --- systemd 事前検証(全て読み取り専用) ----------------------------------------
# --install-systemd では、配置フェーズ(/etc/systemd/system / /etc/limit-monitor
# への書き込み、user / state dir 作成)に入る前に、全ての内容検証を**読み取り専用**
# で完了する。いずれか検証が失敗したら /etc への書き込み(そして current symlink
# 切替)を一切行わない(fail-closed)。
#   検証: rendered unit / systemd-analyze verify / 既存 unit の
#         管理(marker)・非管理(手編集) upgrade 判定 / env の INSTALL_DIR
#         整合 / state dir owner mode / collector token / vendor CLI / CORS
if [[ "${DEPLOY_INSTALL_SYSTEMD}" == "1" ]]; then
  log "validating systemd config (read-only) before placement"

  RENDERED_SYSTEMD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/limit-monitor-units.XXXXXX")"
  RENDERED_ENV_DIR="$(mktemp -d "${TMPDIR:-/tmp}/limit-monitor-envs.XXXXXX")"
  cleanup() {
    local exit_status="$?"
    restore_version_backup "${exit_status}"
    rm -rf "${STAGE_DIR}" "${RENDERED_SYSTEMD_DIR}" "${RENDERED_ENV_DIR}"
    return "${exit_status}"
  }
  trap cleanup EXIT

  # === 検証フェーズ(読み取り専用: /etc には一切書き込まない) ===
  # 検証も配置も --services で選んだ service にだけ触れる。選ばれていない
  # service の unit / env / token には読み書きとも一切触れない。
  # 1) env example を render して検証用 temp を用意(初回も render 結果を検証する)。
  #    unit render(2)より先に済ませることで、collector unit の Type 解決が
  #    配置される env と同じ値(既存 env か render 済み temp)から読む
  if [[ "${INSTALL_SERVER}" -eq 1 ]]; then
    render_env_example "${REPO_ROOT}/deploy/hub.env.example" "${RENDERED_ENV_DIR}/hub.env"
    render_env_example "${REPO_ROOT}/deploy/dashboard.env.example" "${RENDERED_ENV_DIR}/dashboard.env"
  fi
  if [[ "${INSTALL_COLLECTOR}" -eq 1 ]]; then
    render_env_example "${REPO_ROOT}/deploy/collector.env.example" "${RENDERED_ENV_DIR}/collector.env"
    # 1a) collector.env 未作成の初回 install: example 固定 CODEX_BIN/CLAUDE_BIN
    #     (/usr/local/bin/...)をそのまま検証しない。INSTALL_USER の login
    #     shell 経由(`runuser -u <user> -- <shell> -lc 'command -v -- <cli>'`)で
    #     解決した path を temp env へ render して検証する(呼び出し元 env の
    #     CODEX_BIN/CLAUDE_BIN は優先、CLI 不在は die)。render 済み env は
    #     検証後に配置フェーズでもそのまま使う(byte-for-byte 一致、Major 1)
    if [[ ! -e "${LIMIT_MONITOR_ETC_DIR}/collector.env" ]]; then
      render_initial_collector_cli_bins "${RENDERED_ENV_DIR}/collector.env"
    fi
  fi

  # 1b) --hub-base-urlに連動するCORS設定をtemporary envへ同期する。
  #     Dashboardの既存設定(host/port/public origin)は変更せず、現在の
  #     Dashboard originだけをHubのCORS_ALLOWED_ORIGINSへ追加する。
  HUB_ENV_FOR_DEPLOY="$(env_file_or_rendered "${LIMIT_MONITOR_ETC_DIR}/hub.env" "${RENDERED_ENV_DIR}/hub.env")"
  DASHBOARD_ENV_FOR_DEPLOY="$(env_file_or_rendered "${LIMIT_MONITOR_ETC_DIR}/dashboard.env" "${RENDERED_ENV_DIR}/dashboard.env")"
  if [[ "${INSTALL_SERVER}" -eq 1 ]]; then
    dashboard_origin="$(dashboard_origin_from_env "${DASHBOARD_ENV_FOR_DEPLOY}")"
    HUB_ENV_SYNCED="${RENDERED_ENV_DIR}/hub-effective.env"
    sync_hub_cors_origin "${HUB_ENV_FOR_DEPLOY}" "${HUB_ENV_SYNCED}" "${dashboard_origin}"
    HUB_ENV_FOR_DEPLOY="${HUB_ENV_SYNCED}"
    log "synchronized Hub CORS origin for dashboard: ${dashboard_origin}"
  fi

  # 2) rendered unit: 実 node path 注入 + CHANGE_ME placeholder 除去 +
  #    collector の Type を env の interval に整合(temp へ)
  while IFS= read -r template; do
    render_unit_from_template \
      "${REPO_ROOT}/deploy/systemd/${template}" \
      "${DEPLOY_NODE_BIN}" \
      "${RENDERED_SYSTEMD_DIR}/${template}"
    log "rendered ${template} (ExecStart node: ${DEPLOY_NODE_BIN}, User/Group: ${INSTALL_USER}:${INSTALL_GROUP})"
    if [[ "${template}" == "limit-monitor-collector.service" ]]; then
      log "rendered ${template} Type=$(sed -n 's|^Type=||p' "${RENDERED_SYSTEMD_DIR}/${template}") (COLLECTOR_INTERVAL_SECONDS based)"
    fi
  done < <(selected_unit_templates)
  # 3) rendered unit の検証(placeholder 除去 / node 実在 / systemd-analyze verify)
  validate_rendered_units
  # 4) 既存 unit の 管理(marker あり) / 非管理(手編集) upgrade 判定(Major 2)。
  #    非管理(手編集) unit はここで die し、配置フェーズ(書き込み)に進まない
  while IFS= read -r template; do
    check_managed_unit "${RENDERED_SYSTEMD_DIR}/${template}" "${SYSTEMD_DIR}/${template}"
  done < <(selected_unit_templates)
  # 5) env の duplicate key 検出(env を読む systemd install 検証の最初に
  #    die する)。read_env_value は初出の値を使うが systemd の
  #    EnvironmentFile は最後勝ち(last-wins)なので、重複 key があると検証
  #    で使う値と実行時に効く値が食い違う。検証で実際に読む env(既存 env
  #    または render temp)のすべてをチェックする
  selected_env_names=()
  if [[ "${INSTALL_SERVER}" -eq 1 ]]; then
    selected_env_names+=(hub dashboard)
  fi
  if [[ "${INSTALL_COLLECTOR}" -eq 1 ]]; then
    selected_env_names+=(collector)
  fi
  for env_name in "${selected_env_names[@]}"; do
    case "${env_name}" in
      hub) env_target="${HUB_ENV_FOR_DEPLOY}" ;;
      dashboard) env_target="${DASHBOARD_ENV_FOR_DEPLOY}" ;;
      *) env_target="$(env_file_or_rendered "${LIMIT_MONITOR_ETC_DIR}/${env_name}.env" "${RENDERED_ENV_DIR}/${env_name}.env")" ;;
    esac
    if dup_key="$(env_file_has_duplicate_keys "${env_target}")"; then
      die "${env_name}.env has a duplicate key: ${dup_key} (remove the duplicate; systemd EnvironmentFile is last-wins but validation reads the first occurrence)"
    fi
  done
  # 6) env の INSTALL_DIR 整合(既存: 不一致は die / 新規: render 受理)(Major 2)
  for env_name in "${selected_env_names[@]}"; do
    validate_env_install_dir "${REPO_ROOT}/deploy/${env_name}.env.example" "${LIMIT_MONITOR_ETC_DIR}/${env_name}.env"
  done
  if [[ "${INSTALL_SERVER}" -eq 1 ]]; then
    # 7) state dir の owner / mode(Minor 6)。未作成は配置フェーズで作成する。
    #    DB を書くのは hub なので server を install する場合だけ対象にする
    validate_limit_monitor_state_dir
    # 8) CORS: hub.env の CORS_ALLOWED_ORIGINS が dashboard origin を含むか
    validate_dashboard_cors \
      "${HUB_ENV_FOR_DEPLOY}" \
      "${DASHBOARD_ENV_FOR_DEPLOY}"
  fi
  if [[ "${INSTALL_COLLECTOR}" -eq 1 ]]; then
    # 9) collector token: symlink 拒否 / 非空 / root / mode 600(既存は上書きしない)
    validate_collector_token
    # 9a) token を service user が LoadCredential で読める配線になっているか
    validate_collector_credential_wiring "${RENDERED_SYSTEMD_DIR}/limit-monitor-collector.service"
    # 10) vendor CLI: CODEX_BIN / CLAUDE_BIN を INSTALL_USER の環境で検証(Major 1)
    validate_collector_binaries \
      "$(env_file_or_rendered "${LIMIT_MONITOR_ETC_DIR}/collector.env" "${RENDERED_ENV_DIR}/collector.env")"
  fi

  log "all read-only validations passed; proceeding to placement"

  # === 配置フェーズ(全検証完了後のみ /etc へ書き込む) ===
  # etc dir / state dir を用意する(新規のみ作成)。Linux user は作らない
  ensure_systemd_state
  # 管理対象 unit を配置(Major 2)。新規なら配置、既存管理 unit は内容不一致時
  # backup + atomic 更新、非管理は検証フェーズ(4)で die 済み
  while IFS= read -r template; do
    install_managed_unit "${RENDERED_SYSTEMD_DIR}/${template}" "${SYSTEMD_DIR}/${template}" 0644
  done < <(selected_unit_templates)
  # env の初期配置(INSTALL_DIR を deploy 値へ整合: 新規のみ render 配置、
  # 既存は非上書き + 不一致は検証フェーズ(6)で die 済み)
  if [[ "${INSTALL_SERVER}" -eq 1 ]]; then
    # Hub envは検証済みのtemporary内容を配置する。既存envでも
    # CORS_ALLOWED_ORIGINSへのDashboard origin追加だけを反映し、他の値と
    # 既存ファイルのmodeは保持する。
    hub_env_mode=0644
    if [[ -e "${LIMIT_MONITOR_ETC_DIR}/hub.env" ]]; then
      hub_env_mode="$(stat -c '%a' "${LIMIT_MONITOR_ETC_DIR}/hub.env")"
    fi
    install -m "${hub_env_mode}" "${HUB_ENV_FOR_DEPLOY}" "${LIMIT_MONITOR_ETC_DIR}/hub.env"
    log "installed synchronized ${LIMIT_MONITOR_ETC_DIR}/hub.env (Dashboard origin only)"
    ensure_env_install_dir "${REPO_ROOT}/deploy/dashboard.env.example" "${LIMIT_MONITOR_ETC_DIR}/dashboard.env" 0644
  fi
  if [[ "${INSTALL_COLLECTOR}" -eq 1 ]]; then
    # 初回(collector.env 未作成)は検証フェーズ(1a)で CLI path を render 済み
    # の temp をそのまま配置する(byte-for-byte 一致)。既存 env がある場合は
    # 引数なしで従来どおり example から render する(非上書き)
    if [[ -e "${LIMIT_MONITOR_ETC_DIR}/collector.env" ]]; then
      ensure_env_install_dir "${REPO_ROOT}/deploy/collector.env.example" "${LIMIT_MONITOR_ETC_DIR}/collector.env" 0640
    else
      ensure_env_install_dir "${REPO_ROOT}/deploy/collector.env.example" "${LIMIT_MONITOR_ETC_DIR}/collector.env" 0640 \
        "${RENDERED_ENV_DIR}/collector.env"
    fi
  fi
fi

# --- release -----------------------------------------------------------------

log "creating ${VERSION_DIR}"
# 親 versions/ と release dir の mode は明示 0755: service user が current
# release を traverse できる必要がある。owner は deploy 実行ユーザー(root 時は
# root)のまま(既存の versions/current 設計と一致)
install -d -m 0755 "${VERSIONS_DIR}"
if [[ "${FORCE_VERSION}" == "1" && ( -e "${VERSION_DIR}" || -L "${VERSION_DIR}" ) ]]; then
  VERSION_BACKUP_DIR="${VERSIONS_DIR}/.${VERSION_ID}.backup.$$"
  [[ ! -e "${VERSION_BACKUP_DIR}" && ! -L "${VERSION_BACKUP_DIR}" ]] \
    || die "version backup path already exists: ${VERSION_BACKUP_DIR}"
  mv -T -- "${VERSION_DIR}" "${VERSION_BACKUP_DIR}" \
    || die "cannot stage existing version for --force replacement: ${VERSION_DIR}"
fi
install -d -m 0755 "${VERSION_DIR}"
cp -a "${STAGE_DIR}/." "${VERSION_DIR}/"
# mktemp -d の STAGE_DIR は 0700 で、cp -a はその mode を既存の VERSION_DIR へ
# 伝播させる。cp -a の属性伝播に頼らず、ここだけで VERSION_DIR を 0755 に確定させる
# (release 内部の file/dirs は staging 側で install -d / -m 644 / npm ci により
# 既定の安全 mode で生成済み。過度に広げないため再帰 chmod は行わない)
chmod 0755 "${VERSION_DIR}"

# symlink の入れ替えは mv -T で atomic に行う
log "pointing ${INSTALL_DIR}/current at ${VERSION_ID}"
ln -sfn "${VERSION_DIR}" "${INSTALL_DIR}/.current.new"
mv -T "${INSTALL_DIR}/.current.new" "${INSTALL_DIR}/current"

# 古い release を削除する(current の指す先は必ず残す)
current_target="$(readlink -f "${INSTALL_DIR}/current")"
mapfile -t old_versions < <(ls -1 "${VERSIONS_DIR}" | sort -r | tail -n "+$((KEEP_VERSIONS + 1))")
for old in "${old_versions[@]:-}"; do
  [[ -n "${old}" ]] || continue
  old_path="${VERSIONS_DIR}/${old}"
  [[ "$(readlink -f "${old_path}")" != "${current_target}" ]] || continue
  log "pruning old release ${old}"
  rm -rf "${old_path}"
done

# --- systemd -----------------------------------------------------------------

apply_unit_state() {
  local unit="$1"

  # collector oneshot(COLLECTOR_INTERVAL_SECONDS=0)対応: unit は
  # Type=oneshot で render 済み(既定 60 は Type=simple の常駐)。oneshot では
  # systemctl start / restart が実処理終了までブロックする(起動成功 =
  # 処理完了)。1 回実行して終了後は inactive になるが、これは正常状態であり
  # 起動失敗ではない。oneshot の collector のみ active read-back を行わず、
  # start/restart の exit code と systemctl show(Result / ExecMainStatus)で
  # 終了を確認する(下記)。exit code 0 だけでは不十分(プロセスが 0 終了しても
  # CLI 認証 / Hub 送信が失敗している可能性があるため)。
  # oneshot 判定は配置済み unit の Type を正とする(検証フェーズで
  # systemd-analyze verify 済み)。env をここで再読しないのは、render 済み
  # unit と実行時に効く env が食い違う(例: env 変更後未 deploy)場合でも
  # 起動待ちの挙動を実 unit に合わせて確実にしたいため。
  # simple 常駐(interval>0)は従来どおり active read-back を要求する。
  local oneshot=0
  if [[ "$unit" == "${COLLECTOR_SERVICE}.service" ]]; then
    local unit_type
    unit_type="$(sed -n 's|^Type=||p' "${SYSTEMD_DIR}/${unit}" 2>/dev/null | head -n1)"
    if [[ "${unit_type}" == "oneshot" ]]; then
      oneshot=1
    fi
  fi

  # enable 状態と active 状態を分離する(Major 3)。
  # 従来は is-enabled ? restart : enable --now だったため、enabled=false だが
  # active=true の unit では enable --now だけになり旧プロセスが残った。
  # 先に enable を実行し read-back してから、active なら restart、
  # inactive なら start する。各操作後に read-back で状態を確認する。
  log "enabling ${unit}"
  systemctl enable "$unit" \
    || die "enable/start failed for ${unit}: the current symlink already points at the new release. Check 'journalctl -u ${unit}' (roll back the symlink and restart if needed)"
  if ! systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    die "read-back failed: ${unit} is not enabled after 'systemctl enable' (the current symlink points at the new release; check 'journalctl -u ${unit}')"
  fi

  local state
  state="$(systemctl is-active "$unit" 2>/dev/null || true)"
  if [[ "$state" == "active" ]]; then
    log "restarting ${unit}"
    systemctl restart "$unit" \
      || die "restart failed for ${unit}: the current symlink already points at the new release. Check 'journalctl -u ${unit}' (roll back the symlink and restart if needed)"
  else
    log "starting ${unit} (previous state: ${state:-inactive})"
    systemctl start "$unit" \
      || die "start failed for ${unit}: the current symlink already points at the new release. Check 'journalctl -u ${unit}' (roll back the symlink and restart if needed)"
  fi

  if [[ "$oneshot" == "1" ]]; then
    # oneshot: Type=oneshot なので start/restart は実処理終了までブロック済み
    # (exit code 0 は上の `|| die` で検証済み)。ここでは終了後に
    # Result=success かつ ExecMainStatus=0 であることだけ read-back で
    # 確認する(poll は不要)。CLI 認証 / Hub 送信の失敗はプロセスが 0 終了
    # していても ExecMainStatus 非 0 / Result 非 success として検出できる。
    # 終了後は inactive になるが正常なので active read-back は行わない。
    local result exec_main_status
    result="$(systemctl show "$unit" -p Result --value 2>/dev/null || true)"
    exec_main_status="$(systemctl show "$unit" -p ExecMainStatus --value 2>/dev/null || true)"
    if [[ "$result" == "success" && "$exec_main_status" == "0" ]]; then
      log "${unit} is oneshot (COLLECTOR_INTERVAL_SECONDS=0): Result=success ExecMainStatus=0, inactive after exit is normal"
      return 0
    fi
    die "read-back failed: oneshot ${unit} finished with Result=${result:-<unset>} ExecMainStatus=${exec_main_status:-<unset>} (expected Result=success and ExecMainStatus=0; check 'journalctl -u ${unit}' for CLI/auth/Hub send errors)"
  fi

  if [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" != "active" ]]; then
    die "read-back failed: ${unit} is not active after enable + start/restart (the current symlink points at the new release; check 'journalctl -u ${unit}')"
  fi
}

# Hub の readiness エンドポイント /readyz を有限 timeout(既定 30 秒、env で
# 上書き可)で poll して成功を待つ。hub の enable/start|restart の後、
# dashboard / collector の起動の**前**に呼ぶ: dashboard / collector は Hub
# (DB / CORS / token)に依存するため、Hub が ready でないまま進めない。
# listen URL は hub.env の HOST/PORT から組み立てる(localhost bind を前提、
# HOST が wildcard(0.0.0.0 / :: / *)の場合は 127.0.0.1 経由で poll する)。
# Hub 未 ready / HTTP 失敗 / timeout -> die(fail-closed)。
wait_for_hub_ready() {
  local hub_env="${LIMIT_MONITOR_ETC_DIR}/hub.env"
  local host port url
  host="$(trim_space "$(read_env_value "${hub_env}" HOST '127.0.0.1')")"
  port="$(trim_space "$(read_env_value "${hub_env}" PORT '8787')")"
  # wildcard bind はそのまま URL にできないため loopback 経由で poll する
  case "${host}" in
    0.0.0.0|::|\*) host="127.0.0.1" ;;
  esac
  [[ "${host}" =~ ^[0-9A-Za-z._:-]+$ ]] \
    || die "hub.env HOST is not a valid hostname: ${host} (expected a localhost bind)"
  [[ "${port}" =~ ^[0-9]+$ ]] \
    || die "hub.env PORT is not a valid port number: ${port}"
  url="http://${host}:${port}/readyz"
  command -v curl >/dev/null 2>&1 \
    || die "curl not found; it is required to wait for hub readiness (${url})"
  local timeout_seconds="${LIMIT_MONITOR_HUB_READY_TIMEOUT_SECONDS:-30}"
  local deadline=$((SECONDS + timeout_seconds))
  local last_error=""
  local ok=0
  while :; do
    if last_error="$(curl -fsS --max-time 3 "${url}" 2>&1)"; then
      ok=1
      break
    fi
    if (( SECONDS >= deadline )); then
      break
    fi
    sleep 1
  done
  if [[ "${ok}" == "1" ]]; then
    log "hub ready: ${url}"
    return 0
  fi
  die "hub is not ready after ${timeout_seconds}s: ${url} last error: ${last_error:-<no response>}. Dashboard/collector were not started; check 'journalctl -u ${HUB_SERVICE}' and roll back the current symlink if needed"
}

if [[ "${DEPLOY_INSTALL_SYSTEMD}" == "1" ]]; then
  # unit の配置と整合チェック(cmp)は current 切替前に完了済み(M1)。
  # ここでは current が新 release を指すようになったので systemd へ反映し、
  # 起動 / 再起動を行う。失敗時は current が新 release を指したままなので
  # journalctl で確認し、必要なら symlink を旧 release へ戻して再起動する。
  log "daemon-reload"
  systemctl daemon-reload
  if [[ "${INSTALL_SERVER}" -eq 1 ]]; then
    # Hub 先行: enable/start|restart の後、/readyz の readiness を待ってから
    # dashboard / collector を起動する(Hub 依存のため)。Hub 未 ready /
    # HTTP 失敗 / timeout は fail-closed で die(wait_for_hub_ready)。
    apply_unit_state "${HUB_SERVICE}.service"
    wait_for_hub_ready
    apply_unit_state "${DASHBOARD_SERVICE}.service"
  fi
  if [[ "${INSTALL_COLLECTOR}" -eq 1 ]]; then
    # collector 単独 install(Hub は別ホスト)では Hub の readiness を
    # ローカルで待てないため、待たずに起動する。送信失敗は collector 側の
    # 終了コード / ログで検出する
    apply_unit_state "${COLLECTOR_SERVICE}.service"
    log "collector runs as ${INSTALL_USER}:${INSTALL_GROUP} (codex/claude login HOME required)"
  fi
  log "all limit-monitor services run as ${INSTALL_USER}:${INSTALL_GROUP}"
elif [[ "${DEPLOY_RESTART}" == "1" ]]; then
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found but --restart was requested"
  restart_services=()
  if [[ "${INSTALL_SERVER}" -eq 1 ]]; then
    restart_services+=("${HUB_SERVICE}" "${DASHBOARD_SERVICE}")
  fi
  if [[ "${INSTALL_COLLECTOR}" -eq 1 ]]; then
    restart_services+=("${COLLECTOR_SERVICE}")
  fi
  for service in "${restart_services[@]}"; do
    if systemctl list-unit-files "${service}.service" >/dev/null 2>&1 &&
       systemctl is-enabled --quiet "${service}.service" 2>/dev/null; then
      log "restarting ${service}"
      systemctl restart "${service}"
    else
      log "skipping ${service} (unit not enabled)"
    fi
  done
else
  log "release placed but services were not restarted (pass --restart to restart)"
  log "  sudo systemctl restart $(selected_unit_templates | tr '\n' ' ')"
fi

log "done: ${INSTALL_DIR}/current -> ${VERSION_DIR}"

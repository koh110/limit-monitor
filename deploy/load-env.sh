#!/usr/bin/env bash
# shellcheck shell=bash
#
# deploy/deploy.env などの KEY=VALUE ファイルを「呼び出し元の環境変数を
# 優先」で読み込むヘルパー。source すると関数を定義するだけで値は代入しない。
#
# 形式:
#   - 1 行 1 変数の KEY=VALUE
#   - 空行と # から始まるコメント行はスキップ
#   - 値の引用符・エスケープ・インラインコメントは解釈しない(コード実行されない)
#
# 読み込みは deploy.env の値を「まだ設定されていない変数」にだけ適用する。
# 既に設定済みの変数は呼び出し元の値を維持する(単純な `source` だとファイル側
# が上書きしてしまうため)。不正な行(= を含まない行 / 不正な変数名)はエラーで
# 返す(fail-closed)。

env_file_trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_env_file() {
  local file="$1"
  local line key value
  local lineno=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line="$(env_file_trim "$line")"
    if [[ -z "$line" || "$line" == \#* ]]; then
      continue
    fi
    if [[ "$line" != *=* ]]; then
      printf '[deploy-env] ERROR: %s:%d: expected KEY=VALUE (got: %s)\n' "$file" "$lineno" "$line" >&2
      return 1
    fi
    key="${line%%=*}"
    value="${line#*=}"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      printf '[deploy-env] ERROR: %s:%d: invalid variable name: %s\n' "$file" "$lineno" "$key" >&2
      return 1
    fi
    # 呼び出し元に設定済みの変数は優先して維持する
    if [[ -n "${!key+x}" ]]; then
      continue
    fi
    export "$key=$value"
  done < "$file"
  return 0
}

from pathlib import Path
import re

path = Path('deploy/deploy.sh')
text = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    text = text.replace(old, new, 1)


# --providers must persist into collector.env, not be injected as a transient
# systemd Environment= override.
replace_once(
    '''  # --providers 指定時は EnvironmentFile より後ろに Environment= を追加し、
  # env ファイルを編集せず deploy 時の選択を実効設定として固定する。
  if [[ -n "${DEPLOY_COLLECTOR_PROVIDERS:-}" ]]; then
    local env_file_line_count
    env_file_line_count="$(grep -c '^EnvironmentFile=-/etc/limit-monitor/collector.env$' "$out" || true)"
    [[ "${env_file_line_count}" -eq 1 ]] \\
      || die "${unit_name} must contain exactly one collector EnvironmentFile line to apply --providers (got: ${env_file_line_count})"
    sed -i "/^EnvironmentFile=-\\/etc\\/limit-monitor\\/collector.env$/a Environment=COLLECTOR_PROVIDERS=${DEPLOY_COLLECTOR_PROVIDERS}" "$out"
    grep -qxF "Environment=COLLECTOR_PROVIDERS=${DEPLOY_COLLECTOR_PROVIDERS}" "$out" \\
      || die "failed to render collector providers into ${unit_name}"
  fi
''',
    '',
    'remove transient systemd provider override',
)

# Candidate rendering and atomic placement helpers. Candidate generation happens
# in /tmp during the read-only validation phase. The on-disk env is only replaced
# after every validation has passed.
marker = '# 初回 install(collector.env 未作成)用の temp collector.env に、解決済み CLI\n'
if text.count(marker) != 1:
    raise SystemExit(f'helper insertion marker: expected one match, got {text.count(marker)}')
helpers = r'''# --providers の値を collector.env 候補へ反映する。既存 env は直接変更せず、
# 検証用 temp にコピーして COLLECTOR_PROVIDERS だけを canonical な値へ更新する。
# duplicate key は systemd(last-wins)と deploy parser(first-wins)の不一致を生むため
# ここでも fail-closed にする。
render_collector_providers_env() {
  local source="$1"
  local out="$2"
  local providers="$3"
  local count

  [[ -f "$source" && ! -L "$source" ]] \
    || die "collector env source must be a regular file: ${source}"
  count="$(grep -c '^[[:space:]]*COLLECTOR_PROVIDERS=' "$source" || true)"
  [[ "${count}" -le 1 ]] \
    || die "collector.env has duplicate COLLECTOR_PROVIDERS keys; reconcile it before using --providers"

  cp -- "$source" "$out"
  if [[ "${count}" -eq 1 ]]; then
    sed -i "s|^[[:space:]]*COLLECTOR_PROVIDERS=.*$|COLLECTOR_PROVIDERS=${providers}|" "$out"
  else
    printf '\nCOLLECTOR_PROVIDERS=%s\n' "$providers" >> "$out"
  fi
  [[ "$(read_env_value "$out" COLLECTOR_PROVIDERS '')" == "$providers" ]] \
    || die "failed to render COLLECTOR_PROVIDERS into collector env candidate"
}

# 全 read-only validation 後にだけ collector.env 候補を配置する。
# 既存ファイルは同じ directory の temp へ mode/owner をコピーしてから内容を
# 差し替え、mv -T で atomic replace する。--providers 未指定時は呼ばれない。
install_collector_env_candidate() {
  local source="$1"
  local dest="$2"
  local new_mode="${3:-0640}"
  local dest_dir temp

  [[ -f "$source" && ! -L "$source" ]] \
    || die "collector env candidate must be a regular file: ${source}"

  if [[ ! -e "$dest" ]]; then
    install -D -m "$new_mode" "$source" "$dest"
    log "installed ${dest} with deploy-selected collector providers"
    return 0
  fi

  [[ -f "$dest" && ! -L "$dest" ]] \
    || die "refusing to replace non-regular collector env: ${dest}"
  if cmp -s "$source" "$dest"; then
    log "verified collector providers already persisted in ${dest}"
    return 0
  fi

  dest_dir="$(dirname "$dest")"
  temp="$(mktemp "${dest_dir}/.collector.env.XXXXXX")"
  if ! cp -p -- "$dest" "$temp"; then
    rm -f -- "$temp"
    die "failed to preserve collector env metadata before updating ${dest}"
  fi
  if ! cat "$source" > "$temp"; then
    rm -f -- "$temp"
    die "failed to write collector env candidate for ${dest}"
  fi
  mv -T -- "$temp" "$dest"
  log "updated ${dest} collector providers atomically"
}

'''
text = text.replace(marker, helpers + marker, 1)

# Once a candidate exists it is the single source of truth for provider
# validation. Avoid a second side-channel through DEPLOY_COLLECTOR_PROVIDERS.
replace_once(
    '''  if [[ -n "${DEPLOY_COLLECTOR_PROVIDERS:-}" ]]; then
    providers="${DEPLOY_COLLECTOR_PROVIDERS}"
  else
    providers="$(read_env_value "$temp_env" COLLECTOR_PROVIDERS '')"
  fi
''',
    '''  providers="$(read_env_value "$temp_env" COLLECTOR_PROVIDERS '')"
''',
    'render_initial provider source',
)
replace_once(
    '''  if [[ -n "${DEPLOY_COLLECTOR_PROVIDERS:-}" ]]; then
    providers="${DEPLOY_COLLECTOR_PROVIDERS}"
  else
    providers="$(read_env_value "$env_file" COLLECTOR_PROVIDERS '')"
  fi
''',
    '''  providers="$(read_env_value "$env_file" COLLECTOR_PROVIDERS '')"
''',
    'validate provider source',
)

# Build COLLECTOR_ENV_FOR_DEPLOY from either the existing env or the rendered
# example, then apply --providers to a temp candidate. Initial CLI path rendering
# happens after this so it reads the selected providers from the candidate itself.
pattern = re.compile(
    r'''  if \[\[ "\$\{INSTALL_COLLECTOR\}" -eq 1 \]\]; then\n    render_env_example "\$\{REPO_ROOT\}/deploy/collector\.env\.example" "\$\{RENDERED_ENV_DIR\}/collector\.env"\n.*?\n  fi\n\n  # 1b\) --hub-base-url''',
    re.S,
)
replacement = r'''  if [[ "${INSTALL_COLLECTOR}" -eq 1 ]]; then
    render_env_example "${REPO_ROOT}/deploy/collector.env.example" "${RENDERED_ENV_DIR}/collector.env"

    # 既存 env があればそれを基準にし、初回だけ example の render を基準にする。
    # --providers 指定時はどちらの場合も temp candidate へ provider だけ反映し、
    # 以降の検証はこの candidate を正として行う。
    if [[ -e "${LIMIT_MONITOR_ETC_DIR}/collector.env" ]]; then
      COLLECTOR_ENV_FOR_DEPLOY="${LIMIT_MONITOR_ETC_DIR}/collector.env"
    else
      COLLECTOR_ENV_FOR_DEPLOY="${RENDERED_ENV_DIR}/collector.env"
    fi
    if [[ -n "${DEPLOY_COLLECTOR_PROVIDERS:-}" ]]; then
      COLLECTOR_ENV_WITH_PROVIDERS="${RENDERED_ENV_DIR}/collector-effective.env"
      render_collector_providers_env \
        "${COLLECTOR_ENV_FOR_DEPLOY}" \
        "${COLLECTOR_ENV_WITH_PROVIDERS}" \
        "${DEPLOY_COLLECTOR_PROVIDERS}"
      COLLECTOR_ENV_FOR_DEPLOY="${COLLECTOR_ENV_WITH_PROVIDERS}"
      log "prepared collector.env candidate with deploy-selected providers: ${DEPLOY_COLLECTOR_PROVIDERS}"
    fi

    # 初回 install は、candidate が選択した provider に必要な vendor CLI path
    # だけを INSTALL_USER の login shell から解決して同じ candidate へ render する。
    if [[ ! -e "${LIMIT_MONITOR_ETC_DIR}/collector.env" ]]; then
      render_initial_collector_cli_bins "${COLLECTOR_ENV_FOR_DEPLOY}"
    fi
  fi

  # 1b) --hub-base-url'''
text, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit(f'collector validation candidate block: expected one match, got {count}')

replace_once(
    '''      hub) env_target="${HUB_ENV_FOR_DEPLOY}" ;;
      dashboard) env_target="${DASHBOARD_ENV_FOR_DEPLOY}" ;;
      *) env_target="$(env_file_or_rendered "${LIMIT_MONITOR_ETC_DIR}/${env_name}.env" "${RENDERED_ENV_DIR}/${env_name}.env")" ;;
''',
    '''      hub) env_target="${HUB_ENV_FOR_DEPLOY}" ;;
      dashboard) env_target="${DASHBOARD_ENV_FOR_DEPLOY}" ;;
      collector) env_target="${COLLECTOR_ENV_FOR_DEPLOY}" ;;
      *) env_target="$(env_file_or_rendered "${LIMIT_MONITOR_ETC_DIR}/${env_name}.env" "${RENDERED_ENV_DIR}/${env_name}.env")" ;;
''',
    'duplicate-key validation target',
)

replace_once(
    '''    validate_collector_binaries \\
      "$(env_file_or_rendered "${LIMIT_MONITOR_ETC_DIR}/collector.env" "${RENDERED_ENV_DIR}/collector.env")"
''',
    '''    validate_collector_binaries "${COLLECTOR_ENV_FOR_DEPLOY}"
''',
    'collector binary validation target',
)

# Placement: only an explicit --providers request is allowed to mutate an existing
# collector.env. Omitting the option preserves the old non-overwrite behavior.
placement_marker = '  log "all read-only validations passed; proceeding to placement"\n'
pos = text.find(placement_marker)
if pos < 0:
    raise SystemExit('placement marker not found')
head, tail = text[:pos], text[pos:]
placement_pattern = re.compile(
    r'''  if \[\[ "\$\{INSTALL_COLLECTOR\}" -eq 1 \]\]; then\n    # 初回\(collector\.env 未作成\).*?\n  fi\nfi\n\n# --- release''',
    re.S,
)
placement_replacement = r'''  if [[ "${INSTALL_COLLECTOR}" -eq 1 ]]; then
    if [[ -n "${DEPLOY_COLLECTOR_PROVIDERS:-}" ]]; then
      # --providers は deploy の永続設定変更として扱う。検証済み candidate を
      # provider 以外の既存設定・owner・modeを保ったまま atomic replace する。
      install_collector_env_candidate \
        "${COLLECTOR_ENV_FOR_DEPLOY}" \
        "${LIMIT_MONITOR_ETC_DIR}/collector.env" \
        0640
    elif [[ -e "${LIMIT_MONITOR_ETC_DIR}/collector.env" ]]; then
      # option 省略時は従来どおり既存 env を一切変更しない。
      ensure_env_install_dir "${REPO_ROOT}/deploy/collector.env.example" "${LIMIT_MONITOR_ETC_DIR}/collector.env" 0640
    else
      ensure_env_install_dir "${REPO_ROOT}/deploy/collector.env.example" "${LIMIT_MONITOR_ETC_DIR}/collector.env" 0640 \
        "${COLLECTOR_ENV_FOR_DEPLOY}"
    fi
  fi
fi

# --- release'''
tail, count = placement_pattern.subn(placement_replacement, tail, count=1)
if count != 1:
    raise SystemExit(f'collector placement block: expected one match, got {count}')
text = head + tail

# Update misleading top-level comment.
text = text.replace(
    '# deploy option 由来の collector provider。空なら collector.env を使う。',
    '# deploy option 由来の collector provider。指定時は検証後に collector.env へ永続化する。',
    1,
)

path.write_text(text)

# Add focused regression tests for the new persistence helpers and for removal of
# the transient systemd override.
test_path = Path('packages/hub/test/deploy-provider-persistence.test.ts')
test_path.write_text(r'''import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const DEPLOY_SH_PATH = path.join(REPO_ROOT, 'deploy/deploy.sh')
const DEPLOY_SH = fs.readFileSync(DEPLOY_SH_PATH, 'utf8')

function extractBashFn(name: string): string {
  const lines = DEPLOY_SH.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`))
  if (start < 0) throw new Error(`bash function not found: ${name}`)
  const out: string[] = []
  let depth = 0
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    out.push(line)
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (depth === 0) break
  }
  return out.join('\n')
}

function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function runHarness(lines: readonly string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-provider-persist-'))
  try {
    const script = path.join(dir, 'harness.sh')
    fs.writeFileSync(script, ['set -euo pipefail', 'log(){ :; }', 'die(){ echo "$*" >&2; exit 1; }', ...lines].join('\n'))
    const result = spawnSync('bash', [script], { encoding: 'utf8' })
    return { code: result.status ?? 1, out: result.stdout ?? '', err: result.stderr ?? '' }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('deploy --providers は systemd の一時 override ではなく collector.env 永続化を使う', () => {
  expect(DEPLOY_SH).toContain('render_collector_providers_env')
  expect(DEPLOY_SH).toContain('install_collector_env_candidate')
  expect(DEPLOY_SH).not.toContain('Environment=COLLECTOR_PROVIDERS=${DEPLOY_COLLECTOR_PROVIDERS}')
})

test('render_collector_providers_env は provider だけを差し替え、他の既存設定を保持する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-provider-render-'))
  try {
    const source = path.join(dir, 'collector.env')
    const out = path.join(dir, 'candidate.env')
    fs.writeFileSync(
      source,
      ['COLLECTOR_MODE=real', 'COLLECTOR_PROVIDERS=codex,claude', 'SOURCE_ID=existing-host', 'CODEX_BIN=/custom/codex', ''].join('\n')
    )
    const result = runHarness([
      'trim_leading_space(){ local value="$1"; value="${value#"${value%%[![:space:]]*}"}"; printf "%s" "$value"; }',
      extractBashFn('read_env_value'),
      extractBashFn('render_collector_providers_env'),
      `render_collector_providers_env ${shq(source)} ${shq(out)} grok`,
      `cat ${shq(out)}`
    ])
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('COLLECTOR_PROVIDERS=grok')
    expect(result.out).toContain('SOURCE_ID=existing-host')
    expect(result.out).toContain('CODEX_BIN=/custom/codex')
    expect(result.out).not.toContain('COLLECTOR_PROVIDERS=codex,claude')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('render_collector_providers_env は key が無い既存 env に provider を追加できる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-provider-append-'))
  try {
    const source = path.join(dir, 'collector.env')
    const out = path.join(dir, 'candidate.env')
    fs.writeFileSync(source, 'COLLECTOR_MODE=real\nSOURCE_ID=existing-host\n')
    const result = runHarness([
      'trim_leading_space(){ local value="$1"; value="${value#"${value%%[![:space:]]*}"}"; printf "%s" "$value"; }',
      extractBashFn('read_env_value'),
      extractBashFn('render_collector_providers_env'),
      `render_collector_providers_env ${shq(source)} ${shq(out)} codex,grok`,
      `cat ${shq(out)}`
    ])
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('SOURCE_ID=existing-host')
    expect(result.out).toContain('COLLECTOR_PROVIDERS=codex,grok')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('install_collector_env_candidate は既存 env の mode を保って atomic 更新する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-provider-install-'))
  try {
    const source = path.join(dir, 'candidate.env')
    const dest = path.join(dir, 'collector.env')
    fs.writeFileSync(source, 'COLLECTOR_PROVIDERS=grok\nSOURCE_ID=kept\n')
    fs.writeFileSync(dest, 'COLLECTOR_PROVIDERS=codex,claude\nSOURCE_ID=kept\n')
    fs.chmodSync(dest, 0o640)
    const beforeMode = fs.statSync(dest).mode & 0o777
    const result = runHarness([
      extractBashFn('install_collector_env_candidate'),
      `install_collector_env_candidate ${shq(source)} ${shq(dest)} 0640`
    ])
    expect(result.code, result.err).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toBe('COLLECTOR_PROVIDERS=grok\nSOURCE_ID=kept\n')
    expect(fs.statSync(dest).mode & 0o777).toBe(beforeMode)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
''')

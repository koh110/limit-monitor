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

pattern = re.compile(
    r'''  if \[\[ "\$\{INSTALL_COLLECTOR\}" -eq 1 \]\]; then\n    render_env_example "\$\{REPO_ROOT\}/deploy/collector\.env\.example" "\$\{RENDERED_ENV_DIR\}/collector\.env"\n.*?\n  fi\n\n  # 1b\) --hub-base-url''',
    re.S,
)
replacement = r'''  if [[ "${INSTALL_COLLECTOR}" -eq 1 ]]; then
    render_env_example "${REPO_ROOT}/deploy/collector.env.example" "${RENDERED_ENV_DIR}/collector.env"

    if [[ -e "${LIMIT_MONITOR_ETC_DIR}/collector.env" ]]; then
      COLLECTOR_ENV_FOR_DEPLOY="${LIMIT_MONITOR_ETC_DIR}/collector.env"
    else
      COLLECTOR_ENV_FOR_DEPLOY="${RENDERED_ENV_DIR}/collector.env"
    fi

    if [[ -n "${DEPLOY_COLLECTOR_PROVIDERS:-}" ]]; then
      COLLECTOR_ENV_WITH_PROVIDERS="${RENDERED_ENV_DIR}/collector-effective.env"
      "${DEPLOY_NODE_BIN}" --experimental-strip-types \
        "${REPO_ROOT}/deploy/provider-config.ts" render \
        "${COLLECTOR_ENV_FOR_DEPLOY}" \
        "${COLLECTOR_ENV_WITH_PROVIDERS}" \
        "${DEPLOY_COLLECTOR_PROVIDERS}" \
        || die "failed to render deploy-selected providers into collector env candidate"
      COLLECTOR_ENV_FOR_DEPLOY="${COLLECTOR_ENV_WITH_PROVIDERS}"
      log "prepared collector.env candidate with deploy-selected providers: ${DEPLOY_COLLECTOR_PROVIDERS}"
    fi

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
      "${DEPLOY_NODE_BIN}" --experimental-strip-types \
        "${REPO_ROOT}/deploy/provider-config.ts" install \
        "${COLLECTOR_ENV_FOR_DEPLOY}" \
        "${LIMIT_MONITOR_ETC_DIR}/collector.env" \
        0640 \
        || die "failed to persist deploy-selected collector providers"
      log "persisted collector providers in ${LIMIT_MONITOR_ETC_DIR}/collector.env"
    elif [[ -e "${LIMIT_MONITOR_ETC_DIR}/collector.env" ]]; then
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

text = text.replace(
    '# deploy option 由来の collector provider。空なら collector.env を使う。',
    '# deploy option 由来の collector provider。指定時は検証後に collector.env へ永続化する。',
    1,
)

path.write_text(text)

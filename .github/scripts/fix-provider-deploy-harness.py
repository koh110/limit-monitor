from pathlib import Path

path = Path('deploy/deploy.sh')
text = path.read_text()

old_check = '[[ -n "${DEPLOY_COLLECTOR_PROVIDERS}" ]]'
count = text.count(old_check)
if count < 3:
    raise SystemExit(f'expected at least 3 provider option checks, got {count}')
text = text.replace(old_check, '[[ -n "${DEPLOY_COLLECTOR_PROVIDERS:-}" ]]')

old_validate = '''  providers="$(normalize_collector_providers "$(effective_collector_providers "$env_file")" "collector providers (${env_file})")"
  [[ -n "$providers" ]] \\
    || die "collector providers are empty in ${env_file} (allowed: codex, claude, grok)"
'''
new_validate = '''  if [[ -n "${DEPLOY_COLLECTOR_PROVIDERS:-}" ]]; then
    providers="${DEPLOY_COLLECTOR_PROVIDERS}"
  else
    providers="$(read_env_value "$env_file" COLLECTOR_PROVIDERS '')"
  fi
  [[ -n "$providers" ]] \\
    || die "COLLECTOR_PROVIDERS is empty in ${env_file} (set a comma-separated list from codex,claude,grok)"
'''
if text.count(old_validate) != 1:
    raise SystemExit(f'expected one validate provider assignment, got {text.count(old_validate)}')
text = text.replace(old_validate, new_validate, 1)

old_initial = '''  providers="$(normalize_collector_providers "$(effective_collector_providers "$temp_env")" 'collector providers')"
'''
new_initial = '''  if [[ -n "${DEPLOY_COLLECTOR_PROVIDERS:-}" ]]; then
    providers="${DEPLOY_COLLECTOR_PROVIDERS}"
  else
    providers="$(read_env_value "$temp_env" COLLECTOR_PROVIDERS '')"
  fi
'''
if text.count(old_initial) != 1:
    raise SystemExit(f'expected one initial provider assignment, got {text.count(old_initial)}')
text = text.replace(old_initial, new_initial, 1)

path.write_text(text)

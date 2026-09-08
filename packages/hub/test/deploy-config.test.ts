import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'

// packages/hub/test -> repository root
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

function readDeployFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'deploy', relativePath), 'utf8')
}

const HUB_UNIT = readDeployFile('systemd/limit-monitor-hub.service')
const COLLECTOR_UNIT = readDeployFile('systemd/limit-monitor-collector.service')
const DASHBOARD_UNIT = readDeployFile('systemd/limit-monitor-dashboard.service')
const HUB_ENV = readDeployFile('hub.env.example')
const COLLECTOR_ENV = readDeployFile('collector.env.example')
const DASHBOARD_ENV = readDeployFile('dashboard.env.example')
const DEPLOY_SH = readDeployFile('deploy.sh')

/** コメント行を除いた実際の directive / 設定行だけを取り出す */
function directivesOf(content: string): string {
  return content
    .split('\n')
    .filter((line) => {
      return !line.trim().startsWith('#')
    })
    .join('\n')
}

test('systemd unit は配置先を /opt へ固定しない', () => {
  expect(directivesOf(HUB_UNIT)).not.toContain('/opt/limit-monitor')
  expect(directivesOf(COLLECTOR_UNIT)).not.toContain('/opt/limit-monitor')
  expect(directivesOf(DASHBOARD_UNIT)).not.toContain('/opt/limit-monitor')
})

test('systemd unit は INSTALL_DIR を EnvironmentFile で差し替えできる', () => {
  for (const unit of [HUB_UNIT, COLLECTOR_UNIT, DASHBOARD_UNIT]) {
    // ExecStart は引数中で ${INSTALL_DIR} を展開する
    expect(unit).toMatch(/ExecStart=\/usr\/bin\/node \$\{INSTALL_DIR\}\/current\//)
    // 既定値を Environment= で与え、あとの EnvironmentFile= が上書きする
    expect(unit).toContain('Environment=INSTALL_DIR=/var/www/limit-monitor')
    expect(unit).toMatch(/EnvironmentFile=-\/etc\/limit-monitor\//)
    const defaultIndex = unit.indexOf('Environment=INSTALL_DIR=')
    const fileIndex = unit.indexOf('EnvironmentFile=-')
    expect(defaultIndex).toBeLessThan(fileIndex)
  }
})

test('Hub unit は DB path を設定でき、その領域へ書き込める', () => {
  expect(HUB_UNIT).toContain('Environment=DB_FILE_PATH=/var/lib/limit-monitor/limit-monitor.sqlite')
  // StateDirectory が /var/lib/limit-monitor を User 所有で用意する
  expect(HUB_UNIT).toContain('StateDirectory=limit-monitor')
  expect(HUB_UNIT).toContain('ProtectSystem=strict')
})

test('Hub env example は production 前提の必須設定を含む', () => {
  expect(HUB_ENV).toContain('INSTALL_DIR=')
  expect(HUB_ENV).toContain('DB_FILE_PATH=/')
  expect(HUB_ENV).toContain('APP_ENV=production')
  // production では明示 origin が必須(`*` は起動時に失敗する)
  expect(HUB_ENV).toMatch(/^CORS_ALLOWED_ORIGINS=https?:\/\/\S+$/m)
  expect(HUB_ENV).not.toContain('CORS_ALLOWED_ORIGINS=*')
})

test('Collector unit の既定 mode は real で、mock を既定にしない', () => {
  expect(COLLECTOR_UNIT).toContain('Environment=COLLECTOR_MODE=real')
  expect(COLLECTOR_ENV).toContain('COLLECTOR_MODE=real')
  // コメントでの言及は許すが、実際の設定行で mock を既定にしない
  expect(directivesOf(COLLECTOR_UNIT)).not.toContain('COLLECTOR_MODE=mock')
  expect(directivesOf(COLLECTOR_ENV)).not.toContain('COLLECTOR_MODE=mock')
})

test('Collector unit は token を平文 env に置かず credential で注入する', () => {
  expect(COLLECTOR_UNIT).toContain('LoadCredential=hub-token:/etc/limit-monitor/collector-token')
  expect(COLLECTOR_UNIT).toContain('Environment=HUB_TOKEN_FILE=%d/hub-token')
  expect(directivesOf(COLLECTOR_UNIT)).not.toMatch(/Environment=HUB_TOKEN=\S/)
  // env example にも token の値を書かない
  expect(COLLECTOR_ENV).not.toMatch(/^HUB_TOKEN=\S/m)
})

test('Collector unit は vendor CLI が HOME を読めるようにしている', () => {
  // real mode は codex/claude CLI を実行し、CLI 自身が HOME の login 情報を読む
  expect(COLLECTOR_UNIT).toContain('ProtectHome=false')
  expect(directivesOf(COLLECTOR_UNIT)).not.toContain('ProtectHome=true')
  // systemd 配下は PATH が細いため CLI path を明示できるようにする
  expect(COLLECTOR_ENV).toContain('CODEX_BIN=')
  expect(COLLECTOR_ENV).toContain('CLAUDE_BIN=')
})

test('Collector env example は accountAlias を設定しない(既存契約の維持)', () => {
  expect(COLLECTOR_ENV).toContain('SOURCE_ID=')
  expect(COLLECTOR_ENV).not.toMatch(/^ACCOUNT_ALIAS=/m)
})

test('deploy script は fail-closed な bash 設定になっている', () => {
  expect(DEPLOY_SH.startsWith('#!/usr/bin/env bash')).toBe(true)
  expect(DEPLOY_SH).toContain('set -euo pipefail')
})

test('deploy script は実行可能ビットが立っている', () => {
  const mode = fs.statSync(path.join(REPO_ROOT, 'deploy/deploy.sh')).mode
  expect(mode & 0o111).not.toBe(0)
})

test('deploy script は Dashboard の Hub URL を build 時に必須とする', () => {
  expect(DEPLOY_SH).toContain('VITE_HUB_BASE_URL is required')
  expect(DEPLOY_SH).toContain('VITE_HUB_BASE_URL="${VITE_HUB_BASE_URL}" npm run build -w dashboard')
  expect(DEPLOY_SH).toContain('--install-systemd')
})

test('deploy script は INSTALL_DIR を検証する', () => {
  expect(DEPLOY_SH).toContain('INSTALL_DIR must be an absolute path')
  expect(DEPLOY_SH).toContain('INSTALL_DIR must not be /')
  expect(DEPLOY_SH).toContain('INSTALL_DIR="${INSTALL_DIR:-/var/www/limit-monitor}"')
})

test('deploy script は 4 package を build して artifact を検証する', () => {
  for (const workspace of ['shared', 'hub', 'collector', 'dashboard']) {
    expect(DEPLOY_SH).toContain(`npm run build -w ${workspace}`)
  }
  expect(DEPLOY_SH).toContain('build artifact missing')
})

test('deploy script は Dashboard の静的 asset と配信 server の両方を release へ含める', () => {
  // build artifact の検証対象
  expect(DEPLOY_SH).toContain('packages/client/dist/public/index.html')
  expect(DEPLOY_SH).toContain('packages/client/dist/server/index.js')
  // client/dist を staging へ持ち込む(public と server の両方が入る)
  expect(DEPLOY_SH).toContain('stage_package client dist')
  // client server 側の import が本番依存で解決できるか staging で検証する
  expect(DEPLOY_SH).toContain("await import('./packages/client/dist/server/static-server.js')")
  // client 用の EnvironmentFile 例も release へ入れる
  expect(DEPLOY_SH).toContain('deploy/dashboard.env.example')
})

test('deploy script の --install-systemd は unit 配置と systemd 反映を行う', () => {
  expect(DEPLOY_SH).toContain('--install-systemd')
  expect(DEPLOY_SH).toContain('install_if_missing_or_same')
  expect(DEPLOY_SH).toContain('cmp -s')
  expect(DEPLOY_SH).toContain('refusing to overwrite existing')
  expect(DEPLOY_SH).toContain('limit-monitor-hub.service')
  expect(DEPLOY_SH).toContain('limit-monitor-dashboard.service')
  expect(DEPLOY_SH).toContain('limit-monitor-collector.service')
  expect(DEPLOY_SH).toContain('collector-token')
  expect(DEPLOY_SH).toContain('systemctl daemon-reload')
  // 管理対象 unit は marker / backup / atomic 更新で扱う(Major 2)
  expect(DEPLOY_SH).toContain('install_managed_unit')
  expect(DEPLOY_SH).toContain('MANAGED_UNIT_MARKER')
  // enable / active を分離し read-back する(Major 3)。
  // 実行行としての `systemctl enable --now` は残さない(コメント除いて確認)
  expect(DEPLOY_SH).toContain('read-back failed')
  expect(DEPLOY_SH).not.toMatch(/^[^#\n]*systemctl enable --now/m)
})

test('deploy script は deploy 時の実 node path を render 済み unit へ注入する (B1)', () => {
  // unit template は /usr/bin/node のまま保管し、deploy 時に command -v node で
  // 解決した実 path を sed で置換して render する
  expect(DEPLOY_SH).toContain('DEPLOY_NODE_BIN="$(command -v node)"')
  // 注入 path は readlink -f で正規化(実体解決)済みであること
  expect(DEPLOY_SH).toContain('DEPLOY_NODE_BIN="$(readlink -f -- "${DEPLOY_NODE_BIN}")"')
  expect(DEPLOY_SH).toContain('render_unit_from_template')
  expect(DEPLOY_SH).toContain('s|^ExecStart=/usr/bin/node |ExecStart=${node_bin} |')
  // render 済み unit の ExecStart が実際に実行できる node を指すことを検証する
  expect(DEPLOY_SH).toContain('ExecStart references missing node binary')
})

test('deploy script は install user を解決して 3 unit の placeholder を埋める (B2)', () => {
  // 専用 Linux user は作らない / 要求しない(コメントでの言及は許すが実行しない)
  expect(directivesOf(DEPLOY_SH)).not.toContain('useradd')
  expect(directivesOf(DEPLOY_SH)).not.toContain('groupadd')
  // 解決順(SUDO_USER -> 現在のユーザー -> fail-closed)を実装している
  expect(DEPLOY_SH).toContain('resolve_install_identity')
  expect(DEPLOY_SH).toContain('cannot determine the install user')
  // 実アカウント / group の存在も確認する
  expect(DEPLOY_SH).toContain('install user not found')
  expect(DEPLOY_SH).toContain('install group not found')
  // group は passwd の gid から getent group で引く(利用者に指定させない)
  expect(DEPLOY_SH).toContain('cannot resolve the primary group')
  // uid 0 を service 実行ユーザーとして受理しない
  expect(DEPLOY_SH).toContain('refusing to run limit-monitor services as uid 0')
  // 旧 COLLECTOR_USER / COLLECTOR_GROUP は黙って無視せず拒否する
  expect(DEPLOY_SH).toContain('COLLECTOR_USER is no longer supported')
  expect(DEPLOY_SH).toContain('COLLECTOR_GROUP is no longer supported')
  // render 済み unit に placeholder が残っていれば配置前に失敗する
  expect(DEPLOY_SH).toContain('still contains CHANGE_ME placeholder')
})

test('deploy script は service 実行ユーザーの指定入口を持たない (B2)', () => {
  // --user / --group option は廃止(未知引数として die する)
  expect(DEPLOY_SH).not.toMatch(/^\s*--user\)/m)
  expect(DEPLOY_SH).not.toMatch(/^\s*--group\)/m)
  // ユーザー指定 env も廃止。設定されたままなら黙って無視せず拒否する
  expect(DEPLOY_SH).toContain('LIMIT_MONITOR_INSTALL_USER is no longer supported')
  expect(DEPLOY_SH).toContain('LIMIT_MONITOR_INSTALL_GROUP is no longer supported')
  // 解決結果以外を User=/Group= の入力にしない(env からの読み出しが残っていない)
  expect(DEPLOY_SH).not.toContain('${LIMIT_MONITOR_INSTALL_USER}')
  expect(DEPLOY_SH).not.toContain('${LIMIT_MONITOR_INSTALL_GROUP}')
  expect(DEPLOY_SH).not.toContain('${COLLECTOR_USER}')
  expect(DEPLOY_SH).not.toContain('${COLLECTOR_GROUP}')
  // 固定アカウント名を unit / state dir の owner として埋め込まない
  expect(DEPLOY_SH).not.toContain('User=limit-monitor')
  expect(DEPLOY_SH).not.toContain('-o limit-monitor')
})

test('deploy script は current symlink 切替の前に systemd 検証を行う (M1)', () => {
  // render 検証 / env / token / CORS を current を指し直す前に実施する
  const preValidation = DEPLOY_SH.indexOf('validating systemd config (read-only) before placement')
  const symlinkSwap = DEPLOY_SH.indexOf(
    'mv -T "${INSTALL_DIR}/.current.new" "${INSTALL_DIR}/current"'
  )
  expect(preValidation).toBeGreaterThan(0)
  expect(symlinkSwap).toBeGreaterThan(preValidation)
})

test('deploy script は起動失敗を fail-closed にする (M1)', () => {
  // enable/start / restart が失敗したら die して、切り替え済みである旨を明示する
  expect(DEPLOY_SH).toContain('enable/start failed for ${unit}')
  expect(DEPLOY_SH).toContain('restart failed for ${unit}')
  expect(DEPLOY_SH).toContain('journalctl -u ${unit}')
})

// ---- apply_unit_state: collector oneshot(COLLECTOR_INTERVAL_SECONDS=0)対応 ----
// template の既定 Type=simple は安全なデフォルト(手動配置 / 常駐)。deploy.sh
// の render は COLLECTOR_INTERVAL_SECONDS に従って on-disk unit を
// 0 -> Type=oneshot / 0 以外 -> Type=simple に確定する(自動置換)。
// apply_unit_state の oneshot 判定は on-disk unit の Type 行を正とする
// (env を再読しない)。Type=oneshot の unit では systemctl start / restart
// が実処理終了までブロックする(起動成功 = 処理完了)。1 回実行して終了後は
// inactive になるがこれは正常状態なので active read-back は行わず、
// start/restart の exit code と systemctl show(Result / ExecMainStatus)で
// 終了を確定する。exit code 0 だけでは不十分(CLI 認証 / Hub 送信失敗を
// 成功扱いする恐れがある)ため、Result=success かつ ExecMainStatus=0 の時のみ
// 成功とする。Type=simple(常駐)および hub / dashboard は従来どおり active
// read-back を要求する。
// systemctl と SYSTEMD_DIR 配下の stub unit を用意し、実関数(deploy.sh から
// 抽出)を実挙動で検証する。
function runApplyUnitState(opts: {
  unit: string
  envContent?: string
  /** on-disk unit の Type(apply_unit_state の oneshot 判定は on-disk unit の Type 行を正とする) */
  unitType?: 'oneshot' | 'simple'
  preState: string
  startExit?: number
  postState: string
  result?: string
  execMainStatus?: string
}): { code: number; err: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-apply-state-'))
  try {
    const etcDir = path.join(dir, 'etc')
    fs.mkdirSync(etcDir)
    if (opts.envContent !== undefined) {
      fs.writeFileSync(path.join(etcDir, 'collector.env'), opts.envContent)
    }
    // apply_unit_state は oneshot 判定で ${SYSTEMD_DIR}/<unit> の on-disk
    // unit を参照する。安全な一時 dir を用意し、期待 Type を持つ stub unit
    // を置く(set -u 下で SYSTEMD_DIR が unbound になるのを防ぐ)。
    const systemdDir = path.join(dir, 'systemd')
    fs.mkdirSync(systemdDir)
    const unitType = opts.unitType ?? 'simple'
    fs.writeFileSync(
      path.join(systemdDir, opts.unit),
      [
        '[Unit]',
        'Description=limit-monitor test stub',
        '',
        '[Service]',
        `Type=${unitType}`,
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        ''
      ].join('\n')
    )
    const activeFile = path.join(dir, 'active-state')
    fs.writeFileSync(activeFile, opts.preState)
    const postStateFile = path.join(dir, 'post-state')
    fs.writeFileSync(postStateFile, opts.postState)
    const startExitFile = path.join(dir, 'start-exit')
    fs.writeFileSync(startExitFile, String(opts.startExit ?? 0))
    const resultFile = path.join(dir, 'result')
    fs.writeFileSync(resultFile, (opts.result ?? 'success') + '\n')
    const execMainFile = path.join(dir, 'exec-main-status')
    fs.writeFileSync(execMainFile, String(opts.execMainStatus ?? '0') + '\n')
    const binDir = path.join(dir, 'bin')
    fs.mkdirSync(binDir)
    const stub = [
      '#!/bin/bash',
      'cmd="$1"; shift',
      'case "$cmd" in',
      '  enable|is-enabled) exit 0 ;;',
      '  is-active) cat "$ACTIVE_FILE" ;;',
      '  start|restart)',
      '    [ -f "$POST_STATE_FILE" ] && cp "$POST_STATE_FILE" "$ACTIVE_FILE"',
      '    exit "$(cat "$START_EXIT_FILE")"',
      '    ;;',
      '  show)',
      '    prop=""',
      '    while [ $# -gt 0 ]; do',
      '      if [ "$1" = "-p" ]; then prop="$2"; shift 2; else shift; fi',
      '    done',
      '    case "$prop" in',
      '      Result) cat "$RESULT_FILE" ;;',
      '      ExecMainStatus) cat "$EXEC_MAIN_FILE" ;;',
      '      *) printf "\\n" ;;',
      '    esac',
      '    exit 0 ;;',
      'esac',
      'exit 0'
    ].join('\n')
    const stubPath = path.join(binDir, 'systemctl')
    fs.writeFileSync(stubPath, stub)
    fs.chmodSync(stubPath, 0o755)
    const harness = [
      'set -euo pipefail',
      'log(){ :; }',
      'die(){ echo "die: $*" >&2; exit 1; }',
      extractBashFn('trim_leading_space'),
      extractBashFn('read_env_value'),
      extractBashFn('trim_space'),
      'COLLECTOR_SERVICE="limit-monitor-collector"',
      `SYSTEMD_DIR="${systemdDir}"`,
      `LIMIT_MONITOR_ETC_DIR="${etcDir}"`,
      extractBashFn('apply_unit_state'),
      `apply_unit_state "${opts.unit}"`,
      'echo "APPLY_OK"'
    ].join('\n')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const res = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ACTIVE_FILE: activeFile,
        POST_STATE_FILE: postStateFile,
        START_EXIT_FILE: startExitFile,
        RESULT_FILE: resultFile,
        EXEC_MAIN_FILE: execMainFile
      }
    })
    return { code: res.status ?? 1, err: res.stderr ?? '' }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('apply_unit_state: collector oneshot(interval=0) は Result=success/ExecMainStatus=0 で正常', () => {
  // interval=0 + start 成功 + 終了後 inactive + Result=success/ExecMainStatus=0
  // -> 0 終了(active read-back を行わず inactive は正常)
  const ok = runApplyUnitState({
    unit: 'limit-monitor-collector.service',
    unitType: 'oneshot',
    envContent: 'COLLECTOR_INTERVAL_SECONDS=0\n',
    preState: 'inactive',
    startExit: 0,
    postState: 'inactive'
  })
  expect(ok.code, ok.err).toBe(0)
  // restart 経路(起動時に active)も同様に Result/ExecMainStatus が根拠
  const restart = runApplyUnitState({
    unit: 'limit-monitor-collector.service',
    unitType: 'oneshot',
    envContent: 'COLLECTOR_INTERVAL_SECONDS=0\n',
    preState: 'active',
    startExit: 0,
    postState: 'inactive'
  })
  expect(restart.code, restart.err).toBe(0)
})

test('collector unit template の既定は Type=simple で、render が interval に従って Type を確定', () => {
  // template の既定 Type=simple は安全なデフォルト(手動配置 / 常駐)。
  // render_unit_from_template は COLLECTOR_INTERVAL_SECONDS に従って
  // 自動置換する: 0 -> Type=oneshot(systemctl start/restart が実処理
  // 終了までブロックし、1 回実行して終了)、0 以外 -> Type=simple(常駐)。
  // oneshot 時の apply_unit_state 契約(Result/ExecMainStatus read-back)は
  // 上の apply_unit_state oneshot テスト群で別途検証する。
  expect(directivesOf(COLLECTOR_UNIT)).toContain('Type=simple')
  const oneshot = runCollectorTypeRender({
    mode: 'render',
    collectorEnv: 'COLLECTOR_INTERVAL_SECONDS=0\n'
  })
  expect(oneshot.code, oneshot.err).toBe(0)
  expect(oneshot.out).toContain('RENDER_OK')
  expect(oneshot.rendered.split('\n').filter((l) => l.startsWith('Type='))).toEqual([
    'Type=oneshot'
  ])
  const simple = runCollectorTypeRender({
    mode: 'render',
    collectorEnv: 'COLLECTOR_INTERVAL_SECONDS=60\n'
  })
  expect(simple.code, simple.err).toBe(0)
  expect(simple.out).toContain('RENDER_OK')
  expect(simple.rendered.split('\n').filter((l) => l.startsWith('Type='))).toEqual(['Type=simple'])
})

test('apply_unit_state: collector oneshot の start 失敗は必ず fail-closed', () => {
  // oneshot でも start 自体の exit code 非 0 は die(inactive を正常扱いしない)
  const failed = runApplyUnitState({
    unit: 'limit-monitor-collector.service',
    unitType: 'oneshot',
    envContent: 'COLLECTOR_INTERVAL_SECONDS=0\n',
    preState: 'inactive',
    startExit: 1,
    postState: 'inactive'
  })
  expect(failed.code).not.toBe(0)
  expect(failed.err).toContain('start failed for')
})

test('apply_unit_state: oneshot の CLI/auth/Hub 送信失敗は成功扱いしない', () => {
  // start は 0 終了(上記で確認済み)でも Result=success かつ ExecMainStatus=0
  // でない限り die する
  const badResult = runApplyUnitState({
    unit: 'limit-monitor-collector.service',
    unitType: 'oneshot',
    envContent: 'COLLECTOR_INTERVAL_SECONDS=0\n',
    preState: 'inactive',
    startExit: 0,
    postState: 'inactive',
    result: 'exit-code',
    execMainStatus: '1'
  })
  expect(badResult.code).not.toBe(0)
  expect(badResult.err).toContain('read-back failed')
  expect(badResult.err).toContain('Result=exit-code')
  expect(badResult.err).toContain('ExecMainStatus=1')
  // Result=success だが ExecMainStatus 非 0(例: signal による異常終了)も die
  const badStatus = runApplyUnitState({
    unit: 'limit-monitor-collector.service',
    unitType: 'oneshot',
    envContent: 'COLLECTOR_INTERVAL_SECONDS=0\n',
    preState: 'inactive',
    startExit: 0,
    postState: 'inactive',
    result: 'success',
    execMainStatus: '137'
  })
  expect(badStatus.code).not.toBe(0)
  expect(badStatus.err).toContain('read-back failed')
  // 結果が確定していない(空)状態でも即座に die する(poll しない)。
  // Type=oneshot では start 返却時点で結果は確定済みのはずなので、
  // 空のままなら異常として fail-closed する。
  const undetermined = runApplyUnitState({
    unit: 'limit-monitor-collector.service',
    unitType: 'oneshot',
    envContent: 'COLLECTOR_INTERVAL_SECONDS=0\n',
    preState: 'inactive',
    startExit: 0,
    postState: 'inactive',
    result: '',
    execMainStatus: ''
  })
  expect(undetermined.code).not.toBe(0)
  expect(undetermined.err).toContain('read-back failed')
})

test('apply_unit_state: interval が 0 以外 / 未設定の collector は active read-back を維持', () => {
  // interval=60(常駐)で終了後 inactive -> read-back で die
  const resident = runApplyUnitState({
    unit: 'limit-monitor-collector.service',
    envContent: 'COLLECTOR_INTERVAL_SECONDS=60\n',
    preState: 'inactive',
    startExit: 0,
    postState: 'inactive'
  })
  expect(resident.code).not.toBe(0)
  expect(resident.err).toContain('read-back failed')
  // COLLECTOR_INTERVAL_SECONDS 未設定も従来どおり(常駐扱い)
  const unset = runApplyUnitState({
    unit: 'limit-monitor-collector.service',
    envContent: 'SOURCE_ID=dev\n',
    preState: 'inactive',
    startExit: 0,
    postState: 'inactive'
  })
  expect(unset.code).not.toBe(0)
  expect(unset.err).toContain('read-back failed')
  // 常駐 collector は終了後 active なら従来どおり正常
  const active = runApplyUnitState({
    unit: 'limit-monitor-collector.service',
    envContent: 'COLLECTOR_INTERVAL_SECONDS=60\n',
    preState: 'inactive',
    startExit: 0,
    postState: 'active'
  })
  expect(active.code, active.err).toBe(0)
})

test('apply_unit_state: oneshot 判定は collector 専用で hub/dashboard は active 必須を維持', () => {
  // collector.env が interval=0 でも hub unit は oneshot 扱いはされない
  const hub = runApplyUnitState({
    unit: 'limit-monitor-hub.service',
    envContent: 'COLLECTOR_INTERVAL_SECONDS=0\n',
    preState: 'inactive',
    startExit: 0,
    postState: 'inactive'
  })
  expect(hub.code).not.toBe(0)
  expect(hub.err).toContain('read-back failed')
  // hub が active なら従来どおり正常
  const hubActive = runApplyUnitState({
    unit: 'limit-monitor-hub.service',
    envContent: 'COLLECTOR_INTERVAL_SECONDS=0\n',
    preState: 'inactive',
    startExit: 0,
    postState: 'active'
  })
  expect(hubActive.code, hubActive.err).toBe(0)
})

test('Collector unit は oneshot と矛盾しない Restart=on-failure を使う (M2)', () => {
  // COLLECTOR_INTERVAL_SECONDS=0 の oneshot は成功時 0 終了で終わる。
  // Restart=always だと systemd が再実行して「1 回だけ送信」を壊すため、
  // クラッシュ時のみ再試行する on-failure を使う
  expect(COLLECTOR_UNIT).toContain('Restart=on-failure')
  expect(directivesOf(COLLECTOR_UNIT)).not.toContain('Restart=always')
})

// ---- render_unit_from_template: 動的 collector Type 契約 ----
// collector unit の Type は COLLECTOR_INTERVAL_SECONDS で決まる:
// 0 -> oneshot / >0 -> simple。不正値(整数でない / 負)は die(fail-closed)、
// render 後は read-back で期待 Type を検証し不一致なら die(fail-closed)。
// 実関数(deploy.sh から抽出)を実挙動で検証する(runApplyUnitState と
// 同じ方式の小さな harness を再利用する)。
function runCollectorTypeRender(opts: {
  /** resolve: collector_unit_type だけ実行 / render: render_unit_from_template を実行 */
  mode: 'resolve' | 'render'
  /** /etc/limit-monitor/collector.env の内容 */
  collectorEnv?: string
  /** /etc/limit-monitor/hub.env の内容(collector.env 値が空時のフォールバック) */
  hubEnv?: string
  /** collector unit template の Type= 行を除去(read-back fail-closed を検証) */
  dropTypeLine?: boolean
}): { code: number; err: string; out: string; resolvedType?: string; rendered: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-collector-type-'))
  const etcDir = path.join(dir, 'etc')
  const renderedEnvDir = path.join(dir, 'rendered-env')
  const out = path.join(dir, 'limit-monitor-collector.service.rendered')
  try {
    fs.mkdirSync(etcDir)
    fs.mkdirSync(renderedEnvDir)
    if (opts.collectorEnv !== undefined) {
      fs.writeFileSync(path.join(etcDir, 'collector.env'), opts.collectorEnv)
    }
    if (opts.hubEnv !== undefined) {
      fs.writeFileSync(path.join(etcDir, 'hub.env'), opts.hubEnv)
    }
    let templatePath = path.join(REPO_ROOT, 'deploy/systemd/limit-monitor-collector.service')
    if (opts.dropTypeLine) {
      const lines = fs.readFileSync(templatePath, 'utf8').split('\n')
      templatePath = path.join(dir, 'limit-monitor-collector.service')
      fs.writeFileSync(templatePath, lines.filter((l: string) => l !== 'Type=simple').join('\n'))
    }
    const harness = [
      'set -euo pipefail',
      'log(){ :; }',
      'die(){ echo "die: $*" >&2; exit 1; }',
      extractBashFn('trim_leading_space'),
      extractBashFn('read_env_value'),
      extractBashFn('trim_space'),
      extractBashFn('env_file_or_rendered'),
      extractBashFn('collector_unit_type'),
      extractBashFn('render_unit_from_template'),
      `LIMIT_MONITOR_ETC_DIR="${etcDir}"`,
      `RENDERED_ENV_DIR="${renderedEnvDir}"`,
      'INSTALL_USER="deployer"',
      'INSTALL_GROUP="deployer"',
      opts.mode === 'resolve'
        ? 'resolved="$(collector_unit_type)"\necho "RESOLVED_TYPE=${resolved}"'
        : `render_unit_from_template "${templatePath}" "/usr/bin/node" "${out}"\necho "RENDER_OK"`
    ].join('\n')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const res = spawnSync('bash', [scriptPath], { encoding: 'utf8' })
    const outText = res.stdout ?? ''
    const match = outText.match(/^RESOLVED_TYPE=(.*)$/m)
    return {
      code: res.status ?? 1,
      err: res.stderr ?? '',
      out: outText,
      resolvedType: match ? match[1] : undefined,
      rendered: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('collector Type 解決: interval=0 は oneshot / 60 と未設定は simple(既定 60)', () => {
  const oneshot = runCollectorTypeRender({
    mode: 'resolve',
    collectorEnv: 'COLLECTOR_INTERVAL_SECONDS=0\n'
  })
  expect(oneshot.code, oneshot.err).toBe(0)
  expect(oneshot.resolvedType).toBe('oneshot')
  const simple = runCollectorTypeRender({
    mode: 'resolve',
    collectorEnv: 'COLLECTOR_INTERVAL_SECONDS=60\n'
  })
  expect(simple.code, simple.err).toBe(0)
  expect(simple.resolvedType).toBe('simple')
  // 未設定は既定 60 -> simple(deploy.sh の collector_unit_type コメントも既定 60 と明記)
  const unset = runCollectorTypeRender({ mode: 'resolve', collectorEnv: 'SOURCE_ID=dev\n' })
  expect(unset.code, unset.err).toBe(0)
  expect(unset.resolvedType).toBe('simple')
})

test('render: interval=60 の render 結果は Type=simple を含む', () => {
  const r = runCollectorTypeRender({
    mode: 'render',
    collectorEnv: 'COLLECTOR_INTERVAL_SECONDS=60\n'
  })
  expect(r.code, r.err).toBe(0)
  expect(r.out).toContain('RENDER_OK')
  expect(r.rendered.split('\n').filter((l) => l.startsWith('Type='))).toEqual(['Type=simple'])
})

test('render: Type 行欠落の stub template かつ interval=0 の場合は read-back で fail-closed', () => {
  // 現状の template 契約: 既定 Type=simple で、render_unit_from_template は
  // interval=0 なら Type=oneshot に自動置換し read-back で検証する(上の
  // render テストで成功側を確認済み)。置換不能な stub(template の Type 行
  // 欠落)では read-back が oneshot を満たせず必ず die する(fail-closed)。
  // これにより実装の read-back 検証を壊さずに mismatch fail-closed を維持する。
  const r = runCollectorTypeRender({
    mode: 'render',
    dropTypeLine: true,
    collectorEnv: 'COLLECTOR_INTERVAL_SECONDS=0\n'
  })
  expect(r.code).not.toBe(0)
  expect(r.err).toContain(
    'rendered limit-monitor-collector.service Type is <missing>, expected oneshot'
  )
  expect(r.out).not.toContain('RENDER_OK')
})

test('render: interval が非整数 / 負数の場合は fail-closed', () => {
  for (const value of ['abc', '1.5', '-5']) {
    const r = runCollectorTypeRender({
      mode: 'render',
      collectorEnv: `COLLECTOR_INTERVAL_SECONDS=${value}\n`
    })
    expect(r.code, `${value}: ${r.err}`).not.toBe(0)
    expect(r.err).toContain('collector unit Type 解決失敗')
    expect(r.err).toContain(`got: ${value}`)
  }
})

test('render: interval 空 / 未設定は die せず既定 60(Type=simple)へフォールバックする', () => {
  // deploy.sh の契約: 値が空 / 未設定(両 env とも)は既定 60 とみなす
  // (die 対象は非整数 / 負数のみ)
  const empty = runCollectorTypeRender({
    mode: 'render',
    collectorEnv: 'COLLECTOR_INTERVAL_SECONDS=\n'
  })
  expect(empty.code, empty.err).toBe(0)
  expect(empty.rendered).toContain('Type=simple')
  const missing = runCollectorTypeRender({
    mode: 'render',
    collectorEnv: 'SOURCE_ID=dev\n'
  })
  expect(missing.code, missing.err).toBe(0)
  expect(missing.rendered).toContain('Type=simple')
})

test('render: render 済み unit に Type 行が無い(mismatch)場合は fail-closed', () => {
  const r = runCollectorTypeRender({
    mode: 'render',
    dropTypeLine: true,
    collectorEnv: 'COLLECTOR_INTERVAL_SECONDS=60\n'
  })
  expect(r.code).not.toBe(0)
  expect(r.err).toContain(
    'rendered limit-monitor-collector.service Type is <missing>, expected simple'
  )
})

// ---- wait_for_hub_ready: /readyz の有限 timeout polling ----
// --install-systemd は hub を enable/start|restart した後、dashboard /
// collector の起動**前**に Hub の /readyz を有限 timeout(最大 30 秒)で
// HTTP polling する。listen URL は hub.env の HOST/PORT から組み立てる
// (localhost bind を前提、wildcard HOST は 127.0.0.1 経由)。Hub 未 ready /
// HTTP 失敗 / timeout は die(fail-closed)し、dashboard / collector を起動しない。
// curl を stub して実関数(deploy.sh から抽出)を実挙動で検証する。
function runWaitForHubReady(opts: {
  /** hub.env の内容(未指定ならファイル不存在=既定値テスト) */
  envContent?: string
  /** 何回目の curl 呼び出しまで失敗させるか(0 = 初回から成功) */
  readyAfter?: number
  /** LIMIT_MONITOR_HUB_READY_TIMEOUT_SECONDS への上書き(既定 30 秒) */
  timeoutSeconds?: string
}): { code: number; err: string; out: string; curlCalls: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-hub-ready-'))
  try {
    const etcDir = path.join(dir, 'etc')
    fs.mkdirSync(etcDir)
    if (opts.envContent !== undefined) {
      fs.writeFileSync(path.join(etcDir, 'hub.env'), opts.envContent)
    }
    const binDir = path.join(dir, 'bin')
    fs.mkdirSync(binDir)
    const curlLog = path.join(dir, 'curl-calls.log')
    const countFile = path.join(dir, 'curl-count')
    fs.writeFileSync(countFile, '0')
    const readyAfterFile = path.join(dir, 'ready-after')
    fs.writeFileSync(readyAfterFile, String(opts.readyAfter ?? 0) + '\n')
    const curlStub = [
      '#!/bin/bash',
      'echo "$@" >> "$CURL_LOG"',
      'n="$(cat "$CURL_COUNT_FILE" 2>/dev/null || echo 0)"',
      'n=$((n + 1))',
      'echo "$n" > "$CURL_COUNT_FILE"',
      'ready_after="$(cat "$READY_AFTER_FILE")"',
      'if [ "$n" -le "$ready_after" ]; then',
      '  echo "curl: (7) Failed to connect to host" >&2',
      '  exit 7',
      'fi',
      'echo \'{"status":"ok"}\'',
      'exit 0'
    ].join('\n')
    const curlStubPath = path.join(binDir, 'curl')
    fs.writeFileSync(curlStubPath, curlStub)
    fs.chmodSync(curlStubPath, 0o755)
    const harness = [
      'set -euo pipefail',
      'log(){ :; }',
      'die(){ echo "die: $*" >&2; exit 1; }',
      extractBashFn('trim_leading_space'),
      extractBashFn('trim_space'),
      extractBashFn('read_env_value'),
      extractBashFn('wait_for_hub_ready'),
      'HUB_SERVICE="limit-monitor-hub"',
      `LIMIT_MONITOR_ETC_DIR="${etcDir}"`,
      'wait_for_hub_ready',
      'echo "HUB_READY_OK"'
    ].join('\n')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const res = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        CURL_LOG: curlLog,
        CURL_COUNT_FILE: countFile,
        READY_AFTER_FILE: readyAfterFile,
        ...(opts.timeoutSeconds !== undefined
          ? { LIMIT_MONITOR_HUB_READY_TIMEOUT_SECONDS: opts.timeoutSeconds }
          : {})
      }
    })
    const curlCalls = fs.existsSync(curlLog)
      ? fs.readFileSync(curlLog, 'utf8').trim().split('\n')
      : []
    return { code: res.status ?? 1, err: res.stderr ?? '', out: res.stdout ?? '', curlCalls }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('wait_for_hub_ready: /readyz が即応答なら 1 回の poll で成功する', () => {
  const ok = runWaitForHubReady({
    envContent: 'HOST=127.0.0.1\nPORT=8787\n',
    readyAfter: 0
  })
  expect(ok.code, ok.err).toBe(0)
  expect(ok.out).toContain('HUB_READY_OK')
  // URL は hub.env の HOST/PORT から組み立てる(localhost bind 前提)
  expect(ok.curlCalls, 'must poll http://127.0.0.1:8787/readyz').toEqual([
    '-fsS --max-time 3 http://127.0.0.1:8787/readyz'
  ])
})

test('wait_for_hub_ready: 未 ready の間は poll し続け、成功時にのみ進む', () => {
  // 初回・2 回目が HTTP 失敗(503 相当 / 接続拒否)、3 回目で成功
  const ok = runWaitForHubReady({
    envContent: 'HOST=127.0.0.1\nPORT=8787\n',
    readyAfter: 2
  })
  expect(ok.code, ok.err).toBe(0)
  expect(ok.out).toContain('HUB_READY_OK')
  // 成功するまで 3 回 poll されていること(即死しない)
  expect(ok.curlCalls).toHaveLength(3)
  for (const call of ok.curlCalls) {
    expect(call).toContain('http://127.0.0.1:8787/readyz')
  }
})

test('wait_for_hub_ready: PORT は hub.env から、wildcard HOST は 127.0.0.1 経由で poll', () => {
  // PORT=9090: listen URL は 8787 固定ではなく hub.env 値を使う
  const customPort = runWaitForHubReady({
    envContent: 'HOST=127.0.0.1\nPORT=9090\n',
    readyAfter: 0
  })
  expect(customPort.code, customPort.err).toBe(0)
  expect(customPort.curlCalls[0]).toContain('http://127.0.0.1:9090/readyz')
  // wildcard bind(0.0.0.0)は URL にできないため loopback 経由
  const wildcard = runWaitForHubReady({
    envContent: 'HOST=0.0.0.0\nPORT=8787\n',
    readyAfter: 0
  })
  expect(wildcard.code, wildcard.err).toBe(0)
  expect(wildcard.curlCalls[0]).toContain('http://127.0.0.1:8787/readyz')
  expect(wildcard.curlCalls[0]).not.toContain('0.0.0.0')
})

test('wait_for_hub_ready: hub.env が無い場合は既定 127.0.0.1:8787 を使う', () => {
  const defaults = runWaitForHubReady({ readyAfter: 0 })
  expect(defaults.code, defaults.err).toBe(0)
  expect(defaults.curlCalls[0]).toContain('http://127.0.0.1:8787/readyz')
})

test('wait_for_hub_ready: 未 ready が続くと timeout で fail-closed に die する', () => {
  // 既定 30 秒はテストでは長すぎるため env で 2 秒へ短縮(上限は 30 秒固定)
  const timeout = runWaitForHubReady({
    envContent: 'HOST=127.0.0.1\nPORT=8787\n',
    readyAfter: 999999,
    timeoutSeconds: '2'
  })
  expect(timeout.code).not.toBe(0)
  expect(timeout.err).toContain('hub is not ready after 2s')
  expect(timeout.err).toContain('http://127.0.0.1:8787/readyz')
  expect(timeout.err).toContain('Dashboard/collector were not started')
  expect(timeout.out).not.toContain('HUB_READY_OK')
  // timeout 上限は 30 秒(既定値)であること(静的)
  expect(DEPLOY_SH).toContain('LIMIT_MONITOR_HUB_READY_TIMEOUT_SECONDS:-30')
  // HTTP 失敗は curl の exit code で検出する(-fsS: 非 2xx も失敗)
  expect(DEPLOY_SH).toContain('curl -fsS --max-time 3 "${url}"')
})

test('--install-systemd は hub 起動後に /readyz を待ち、その後に dashboard/collector を起動する', () => {
  // 順序: hub の enable/start|restart -> /readyz polling -> dashboard/collector
  const idxHub = DEPLOY_SH.indexOf('    apply_unit_state "${HUB_SERVICE}.service"\n')
  const idxWait = DEPLOY_SH.indexOf('\n    wait_for_hub_ready\n')
  const idxDash = DEPLOY_SH.indexOf('    apply_unit_state "${DASHBOARD_SERVICE}.service"\n')
  const idxCollector = DEPLOY_SH.indexOf('    apply_unit_state "${COLLECTOR_SERVICE}.service"\n')
  expect(idxHub, 'hub must be applied first').toBeGreaterThan(0)
  expect(idxWait, 'readyz wait must come after hub apply').toBeGreaterThan(idxHub)
  expect(idxDash, 'dashboard must start after readyz wait').toBeGreaterThan(idxWait)
  expect(idxCollector, 'collector must start after dashboard').toBeGreaterThan(idxDash)
  // readyz 待ちが hub 専用で、dashboard/collector 起動ループに含まれていないこと
  const readyFn = extractBashFn('wait_for_hub_ready')
  expect(readyFn).toContain('/readyz')
  expect(readyFn).not.toContain('systemctl')
  expect(readyFn).not.toContain('DASHBOARD_SERVICE')
  expect(readyFn).not.toContain('COLLECTOR_SERVICE')
  // hub.env の HOST/PORT から listen URL を組み立てる(localhost bind 前提)
  expect(readyFn).toContain('read_env_value "${hub_env}" HOST \'127.0.0.1\'')
  expect(readyFn).toContain('read_env_value "${hub_env}" PORT \'8787\'')
  // 既存の CORS / token 検証経路を壊していない(静的: 呼び出しが維持される)
  expect(DEPLOY_SH).toContain('validate_dashboard_cors')
  expect(DEPLOY_SH).toContain('validate_collector_token')
})

test('deploy script は current symlink を atomic に切り替える', () => {
  expect(DEPLOY_SH).toContain('mv -T "${INSTALL_DIR}/.current.new" "${INSTALL_DIR}/current"')
})

test('--install-systemd / --restart の preflight required tools に curl が含まれる (Major)', () => {
  // wait_for_hub_ready は hub 起動後に /readyz を poll するため curl が必須。
  // その不在を /etc 配置 / current symlink 切替 / systemd restart より前に
  // fail-closed で検出する(既存 tool loop の条件・メッセージ形式に合わせる)
  const requiredLoop =
    'if [[ "${DEPLOY_INSTALL_SYSTEMD}" == "1" || "${DEPLOY_RESTART}" == "1" ]]; then\n' +
    '  # curl: wait_for_hub_ready は hub 起動後に /readyz を poll して\n' +
    '  # readiness を待つため必須。/etc 配置 / current symlink 切替 /\n' +
    '  # systemd restart の前に事前検証で fail-closed する(通常 build /\n' +
    '  # --prepare-build 経路は不要)\n' +
    '  # useradd / groupadd は要求しない: limit-monitor は Linux user を作らず、\n' +
    '  # install を実行した通常ユーザーをそのまま service 実行ユーザーにする\n' +
    '  for tool in systemctl curl; do\n' +
    '    command -v "${tool}" >/dev/null 2>&1 || die "required tool not found for systemd operations: ${tool}"\n' +
    '  done'
  expect(DEPLOY_SH).toContain(requiredLoop)
  // preflight(事前検証)が /etc 配置フェーズと current symlink 切替より前にあること
  const idxPreflight = DEPLOY_SH.indexOf('required tool not found for systemd operations: ${tool}')
  const idxPlacement = DEPLOY_SH.indexOf('validating systemd config (read-only) before placement')
  const idxSymlinkSwap = DEPLOY_SH.indexOf(
    'mv -T "${INSTALL_DIR}/.current.new" "${INSTALL_DIR}/current"'
  )
  const idxSystemdReflect = DEPLOY_SH.indexOf('systemctl daemon-reload')
  expect(idxPreflight).toBeGreaterThan(0)
  expect(idxPlacement).toBeGreaterThan(idxPreflight)
  expect(idxSymlinkSwap).toBeGreaterThan(idxPreflight)
  expect(idxSystemdReflect).toBeGreaterThan(idxPreflight)
  // wait_for_hub_ready が curl の必要性を参照していること(静的)
  const readyFn = extractBashFn('wait_for_hub_ready')
  expect(readyFn).toContain('command -v curl')
  // 通常 build / --prepare-build 経路の common tool loop は curl を要求しないこと
  const commonToolLoop = DEPLOY_SH.indexOf(
    'for tool in node npm git install ln mv cp cmp getent stat sed runuser sha256sum awk find sort xargs; do'
  )
  expect(commonToolLoop).toBeGreaterThan(0)
  const commonLoopEnd = DEPLOY_SH.indexOf('done', commonToolLoop)
  expect(commonLoopEnd).toBeGreaterThan(commonToolLoop)
  expect(DEPLOY_SH.slice(commonToolLoop, commonLoopEnd).includes('curl')).toBe(false)
})

test('deploy script は既定でサービスを再起動しない', () => {
  expect(DEPLOY_SH).toContain('DEPLOY_RESTART="${DEPLOY_RESTART:-0}"')
})

test('Dashboard は Node.js service として配信し nginx に依存しない', () => {
  // 配信は client package の Node server(dist/server/index.js)が行う
  expect(DASHBOARD_UNIT).toContain(
    'ExecStart=/usr/bin/node ${INSTALL_DIR}/current/packages/client/dist/server/index.js'
  )
  // nginx 用の設定を必須経路へ残さない
  expect(fs.existsSync(path.join(REPO_ROOT, 'deploy/nginx'))).toBe(false)
  for (const content of [DEPLOY_SH, DASHBOARD_UNIT, DASHBOARD_ENV, HUB_ENV, COLLECTOR_ENV]) {
    expect(directivesOf(content).toLowerCase()).not.toContain('nginx')
  }
})

test('Dashboard unit は port と bind address を設定で切り替えられる', () => {
  // 他サービスと同居させるため port は環境変数で変えられる
  expect(DASHBOARD_UNIT).toContain('Environment=PORT=8788')
  expect(DASHBOARD_ENV).toMatch(/^PORT=\d+$/m)
  // 既定は localhost bind。LAN へ出すのは明示設定したときだけ
  expect(DASHBOARD_UNIT).toContain('Environment=HOST=127.0.0.1')
  expect(DASHBOARD_ENV).toMatch(/^HOST=\S+$/m)
  expect(directivesOf(DASHBOARD_ENV)).not.toContain('HOST=0.0.0.0')
  // Hub とは別 service にする(同居できるよう Hub の port を奪わない)
  expect(directivesOf(DASHBOARD_UNIT)).not.toContain('PORT=8787')
})

test('Dashboard unit は read only 配信に必要な hardening を持つ', () => {
  expect(DASHBOARD_UNIT).toContain('ProtectSystem=strict')
  expect(DASHBOARD_UNIT).toContain('ProtectHome=true')
  expect(DASHBOARD_UNIT).toContain('NoNewPrivileges=true')
  // 静的配信だけなので書き込み path は要らない
  expect(directivesOf(DASHBOARD_UNIT)).not.toContain('ReadWritePaths=')
})

test('Hub の CORS 許可 origin は Dashboard の public origin と一致する', () => {
  const dashboardHost = /^HOST=(\S+)$/m.exec(DASHBOARD_ENV)?.[1]
  const dashboardPort = /^PORT=(\d+)$/m.exec(DASHBOARD_ENV)?.[1]
  const publicOrigin = /^DASHBOARD_PUBLIC_ORIGIN=(\S+)$/m.exec(DASHBOARD_ENV)?.[1]
  expect(dashboardHost).toBeDefined()
  expect(dashboardPort).toBeDefined()
  // bind address(HOST)はブラウザが送る origin ではない。
  // localhost 既定 bind のみ HOST/PORT 由来で導出し、LAN bind は
  // DASHBOARD_PUBLIC_ORIGIN で明示指定する。
  const clientOrigin = publicOrigin ?? `http://${dashboardHost}:${dashboardPort}`
  const corsOrigins = /^CORS_ALLOWED_ORIGINS=(\S+)$/m.exec(HUB_ENV)?.[1]
  expect(corsOrigins).toBeDefined()
  expect((corsOrigins ?? '').split(',')).toContain(clientOrigin)
})

test('deploy script は deploy.env を読み込む際に呼び出し元 env を優先する', () => {
  // source による単純上書きをしない(関数定義のみで値は代入されない)
  expect(DEPLOY_SH).not.toMatch(/set -a && source .*deploy\.env/)
  // 未設定変数にだけ値を適用するヘルパーを使う
  expect(DEPLOY_SH).toContain('source "${REPO_ROOT}/deploy/load-env.sh"')
  expect(DEPLOY_SH).toContain('load_env_file "${REPO_ROOT}/deploy/deploy.env"')
})

test('deploy script は Dashboard の public origin を bind address と分離する', () => {
  // CORS 検証は DASHBOARD_PUBLIC_ORIGIN(または localhost 既定の HOST/PORT 導出)を使う
  expect(DEPLOY_SH).toContain('DASHBOARD_PUBLIC_ORIGIN')
  // LAN bind で public origin 未設定なら fail-closed
  expect(DEPLOY_SH).toContain('DASHBOARD_PUBLIC_ORIGIN must be set')
})

// ---- validate_dashboard_cors の実挙動を bash で検証する ----
// deploy.sh の関数だけ抽出し、一時 env dir に対して実際に実行する。
// 目的: CORS_ALLOWED_ORIGINS をカンマ分割したとき、各 origin の前後空白を
// trim してから比較すること(= Hub 本体の .split(',').map(trim).filter(len>0) と一致)
// を確認する。trim しないと " http://a" は "http://a" と不一致になる。

const DEPLOY_SH_PATH = path.join(REPO_ROOT, 'deploy', 'deploy.sh')

/**
 * 指定 bash 関数を deploy.sh から抽出する(ブレースの数を数えて抽出)。
 * before が指定されると、関数定義行より前の最後の before 行以降(コメント・
 * 変数代入などの前段定義、例: manifest セクションの BUILD_MANIFEST_FILE 代入)
 * も含めて抽出する。
 */
function extractBashFn(fn: string, before?: string): string {
  const src = fs.readFileSync(DEPLOY_SH_PATH, 'utf8')
  const lines = src.split('\n')
  const fnIdx = lines.findIndex((line) => line.startsWith(`${fn}() {`))
  if (fnIdx < 0) throw new Error(`bash function not found: ${fn}`)
  let startIdx = fnIdx
  if (before !== undefined) {
    const beforeIdx = lines.slice(0, fnIdx).findLastIndex((l) => l.startsWith(before))
    if (beforeIdx < 0) {
      throw new Error(`preamble line not found before ${fn}: ${before}`)
    }
    startIdx = beforeIdx
  }
  const out: string[] = []
  let depth = 0
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? ''
    out.push(line)
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (i >= fnIdx && depth === 0) break
  }
  return out.join('\n')
}

/**
 * validate_dashboard_cors を一時 env dir に対して実行して (exitCode, stderr) を返す。
 * hub.env / dashboard.env の内容は引数で与える(値には意図的に空白を混ぜる)。
 */
function runValidateCors(opts: { hubCors: string; dashboardEnv?: string }): {
  code: number
  err: string
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-cors-test-'))
  try {
    fs.writeFileSync(path.join(dir, 'hub.env'), `CORS_ALLOWED_ORIGINS=${opts.hubCors}\n`)
    fs.writeFileSync(
      path.join(dir, 'dashboard.env'),
      opts.dashboardEnv ?? 'HOST=127.0.0.1\nPORT=8788\n'
    )
    const harness = [
      'set -euo pipefail',
      extractBashFn('trim_leading_space'),
      extractBashFn('trim_space'),
      extractBashFn('read_env_value'),
      extractBashFn('die'),
      extractBashFn('is_strict_origin'),
      extractBashFn('dashboard_origin_from_env'),
      extractBashFn('validate_dashboard_cors'),
      'LIMIT_MONITOR_ETC_DIR="__DIR__"',
      'validate_dashboard_cors',
      'echo "CORS_OK"'
    ]
      .join('\n')
      .replaceAll('__DIR__', dir)
    const script = path.join(dir, 'harness.sh')
    fs.writeFileSync(script, harness)
    let err = ''
    try {
      execFileSync('bash', [script], { encoding: 'utf8' })
      return { code: 0, err }
    } catch (e) {
      err = (e as { stderr?: string }).stderr ?? ''
      return { code: (e as { code?: number }).code ?? 1, err }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('validate_dashboard_cors: localhost で PORT 未設定なら Dashboard 既定 port 8788 を導出する', () => {
  const derived = runValidateCors({
    hubCors: 'http://127.0.0.1:8788',
    dashboardEnv: 'HOST=127.0.0.1\n'
  })
  expect(derived.code, derived.err).toBe(0)
})
test('validate_dashboard_cors: CORS_ALLOWED_ORIGINS の各 origin は trim してから比較する', () => {
  // " http://127.0.0.1:8788 " の前後空白を trim して localhost 既定 origin と一致させる
  const allowed = runValidateCors({ hubCors: ' http://127.0.0.1:8788 ' })
  expect(allowed.code).toBe(0)
  // 空白なし(従来動作)は引き続き一致する
  const noSpace = runValidateCors({ hubCors: 'http://127.0.0.1:8788' })
  expect(noSpace.code).toBe(0)
})

test('validate_dashboard_cors: 複数の origin のうち trim 後の一致分を許可する', () => {
  // 3 件目の " http://127.0.0.1:8788 " だけが trim 後に一致する
  const multi = runValidateCors({
    hubCors: 'https://a.example, http://127.0.0.1:8788 , https://b.example'
  })
  expect(multi.code).toBe(0)
})

test('validate_dashboard_cors: trim しても一致しない origin は fail-closed', () => {
  // 一致 origin がない(127.0.0.1:8788 ではない)→ die して非ゼロ終了
  const denied = runValidateCors({ hubCors: ' https://a.example , https://b.example ' })
  expect(denied.code).not.toBe(0)
  expect(denied.err).toContain('must allow dashboard origin http://127.0.0.1:8788')
})

test('validate_dashboard_cors: 空要素(カンマの空白)は trim + filter でスキップする', () => {
  // 先頭/末尾の余分なカンマで生じる空 origin はスキップし、実体は一致する
  const withEmpty = runValidateCors({
    hubCors: ' , http://127.0.0.1:8788 , '
  })
  expect(withEmpty.code).toBe(0)
})

function runSyncHubCorsOrigin(opts: { hubCors: string; dashboardOrigin: string }): {
  code: number
  content: string
  err: string
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-cors-sync-test-'))
  const source = path.join(dir, 'hub.env')
  const dest = path.join(dir, 'hub-effective.env')
  try {
    fs.writeFileSync(source, `APP_ENV=production\nCORS_ALLOWED_ORIGINS=${opts.hubCors}\nDB_FILE_PATH=/safe/path\n`)
    const harness = [
      'set -euo pipefail',
      extractBashFn('trim_space'),
      extractBashFn('die'),
      extractBashFn('sync_hub_cors_origin'),
      `sync_hub_cors_origin "${source}" "${dest}" "${opts.dashboardOrigin}"`
    ].join('\n')
    const script = path.join(dir, 'harness.sh')
    fs.writeFileSync(script, harness)
    try {
      execFileSync('bash', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, content: fs.readFileSync(dest, 'utf8'), err: '' }
    } catch (e) {
      return {
        code: (e as { code?: number }).code ?? 1,
        content: fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '',
        err: (e as { stderr?: string }).stderr ?? ''
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('sync_hub_cors_origin: Dashboard originだけを追加し、既存設定を保持する', () => {
  const result = runSyncHubCorsOrigin({
    hubCors: 'http://127.0.0.1:8788',
    dashboardOrigin: 'http://192.168.11.53:8788'
  })
  expect(result.code, result.err).toBe(0)
  expect(result.content).toContain('APP_ENV=production\n')
  expect(result.content).toContain(
    'CORS_ALLOWED_ORIGINS=http://127.0.0.1:8788,http://192.168.11.53:8788\n'
  )
  expect(result.content).toContain('DB_FILE_PATH=/safe/path\n')
})

// ---- unit render (B1/B2) の実挙動を bash で検証する ----
// render_unit_from_template / validate_rendered_units を deploy.sh から抽出し、
// 実テンプレートに対して実行して render 結果を検証する。
// 実行ユーザーは deploy を実行した通常ユーザー(install user)へ統一するため、
// テストでも特定アカウント名に依存しない。実運用の固定アカウントと誤解されない
// よう、テストデータであることが読んで分かる名前を使う。
const INSTALL_IDENTITY_USER = 'testdata-install-user'
const INSTALL_IDENTITY_GROUP = 'testdata-install-group'

function runUnitRender(opts: {
  nodeBin?: string
  /** 解決済み install identity(3 unit 共通の User=/Group=) */
  installUser?: string
  installGroup?: string
  forcePlaceholder?: boolean
}): { code: number; err: string; rendered: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-render-test-'))
  try {
    const unitsDir = path.join(dir, 'units')
    fs.mkdirSync(unitsDir)
    for (const name of [
      'limit-monitor-hub',
      'limit-monitor-collector',
      'limit-monitor-dashboard'
    ]) {
      const src = fs.readFileSync(
        path.join(REPO_ROOT, 'deploy', 'systemd', `${name}.service`),
        'utf8'
      )
      fs.writeFileSync(path.join(dir, `${name}.service.tpl`), src)
    }
    const harness = [
      'set -euo pipefail',
      'log() { :; }',
      extractBashFn('die'),
      extractBashFn('render_unit_from_template'),
      extractBashFn('validate_rendered_units'),
      `INSTALL_USER="${opts.installUser ?? ''}"`,
      `INSTALL_GROUP="${opts.installGroup ?? ''}"`,
      `FORCE_PLACEHOLDER="${opts.forcePlaceholder ? 1 : 0}"`,
      `RENDERED_SYSTEMD_DIR="${unitsDir}"`,
      `node_bin="${opts.nodeBin ?? process.execPath}"`,
      'for tpl in limit-monitor-hub limit-monitor-collector limit-monitor-dashboard; do',
      `  render_unit_from_template "${dir}/\${tpl}.service.tpl" "\$node_bin" "${unitsDir}/\${tpl}.service"`,
      'done',
      'if [[ "${FORCE_PLACEHOLDER}" == "1" ]]; then',
      `  sed -i 's|^User=.*|User=CHANGE_ME|' "${unitsDir}/limit-monitor-collector.service"`,
      'fi',
      'validate_rendered_units',
      'echo "RENDER_OK"'
    ].join('\n')
    const script = path.join(dir, 'harness.sh')
    fs.writeFileSync(script, harness)
    let err = ''
    try {
      execFileSync('bash', [script], { encoding: 'utf8' })
    } catch (e) {
      err = (e as { stderr?: string }).stderr ?? ''
      return { code: (e as { code?: number }).code ?? 1, err, rendered: [] }
    }
    const rendered = fs.readdirSync(unitsDir).map((name: string) => {
      return fs.readFileSync(path.join(unitsDir, name), 'utf8')
    })
    return { code: 0, err, rendered }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('unit render: ExecStart の node path は deploy 時の実 path へ置換される (B1)', () => {
  // 環境非依存に、テスト実行中の node 本体を「実 path」として render する
  const nodeBin = process.execPath
  const ok = runUnitRender({
    nodeBin,
    installUser: INSTALL_IDENTITY_USER,
    installGroup: INSTALL_IDENTITY_GROUP
  })
  expect(ok.code).toBe(0)
  for (const rendered of ok.rendered) {
    expect(rendered).toContain(`ExecStart=${nodeBin} \${INSTALL_DIR}/current/`)
    expect(rendered).not.toContain('ExecStart=/usr/bin/node ')
    // systemd 展開用の \${INSTALL_DIR} は残る
    expect(rendered).toContain('${INSTALL_DIR}')
  }
})

test('unit render: hub / dashboard / collector の 3 unit が同じ install identity で埋まる (B2)', () => {
  const ok = runUnitRender({
    nodeBin: process.execPath,
    installUser: INSTALL_IDENTITY_USER,
    installGroup: INSTALL_IDENTITY_GROUP
  })
  expect(ok.code).toBe(0)
  expect(ok.rendered).toHaveLength(3)
  // 3 unit すべてが解決済み identity ちょうど 1 行ずつを持ち、placeholder は残らない
  for (const rendered of ok.rendered) {
    const userLines = rendered.split('\n').filter((line) => line.startsWith('User='))
    const groupLines = rendered.split('\n').filter((line) => line.startsWith('Group='))
    expect(userLines).toEqual([`User=${INSTALL_IDENTITY_USER}`])
    expect(groupLines).toEqual([`Group=${INSTALL_IDENTITY_GROUP}`])
    expect(rendered).not.toContain('CHANGE_ME')
  }
  // hub / dashboard / collector が揃っていることを Description で確認する
  const descriptions = ok.rendered
    .map((content) => {
      return content.split('\n').find((line) => line.startsWith('Description=')) ?? ''
    })
    .sort()
  expect(descriptions.filter((d) => d.includes('Collector'))).toHaveLength(1)
  expect(descriptions.filter((d) => d.includes('Dashboard'))).toHaveLength(1)
  expect(descriptions.filter((d) => d.includes('Hub'))).toHaveLength(1)
})

test('unit render: ExecStart が無い node を指す unit は配置前に失敗する (B1)', () => {
  const denied = runUnitRender({
    nodeBin: '/definitely/not/installed/node',
    installUser: INSTALL_IDENTITY_USER,
    installGroup: INSTALL_IDENTITY_GROUP
  })
  expect(denied.code).not.toBe(0)
  expect(denied.err).toContain('ExecStart references missing node binary')
})

test('unit render: placeholder が残った unit は配置前に失敗する (B2)', () => {
  // render 後に placeholder が残り(未指定のまま配置される)想定を再現して
  // validate_rendered_units が die することを確認する
  const denied = runUnitRender({
    nodeBin: process.execPath,
    installUser: INSTALL_IDENTITY_USER,
    installGroup: INSTALL_IDENTITY_GROUP,
    forcePlaceholder: true
  })
  expect(denied.code).not.toBe(0)
  expect(denied.err).toContain('still contains CHANGE_ME placeholder')
})

// ---- 新 review 対応(Major 1/2/4/5)の bash 実挙動テスト ----

test('M4: DASHBOARD_PUBLIC_ORIGIN として不正な URL は fail-closed (deploy bash 側)', () => {
  // pathname / search / hash / userinfo を伴う URL は拒否する(client 側の
  // isStrictOrigin と同じ URL 集合)。hubCors は検証前に die するため値は問わず、
  // dashboard.env に DASHBOARD_PUBLIC_ORIGIN を書いて runValidateCors を回す
  for (const bad of [
    'http://192.168.1.10:3000/path',
    'http://192.168.1.10:3000?x=1',
    'http://192.168.1.10:3000#frag',
    'http://user:pass@192.168.1.10:3000',
    'ftp://192.168.1.10:3000',
    'https://example.com/'
  ]) {
    const res = runValidateCors({
      hubCors: 'http://192.168.1.10:3000',
      dashboardEnv: `HOST=127.0.0.1\nPORT=8788\nDASHBOARD_PUBLIC_ORIGIN=${bad}\n`
    })
    expect(res.code, `should die for origin ${bad}: ${res.err}`).not.toBe(0)
    expect(res.err).toContain('DASHBOARD_PUBLIC_ORIGIN must be an origin')
  }
  // http(s)://host[:port] のみ(pathname なし。末尾 / は Hub の exact match と
  // 不一致になるため拒否)は受理
  const good = runValidateCors({
    hubCors: 'http://192.168.1.10:3000',
    dashboardEnv: 'HOST=127.0.0.1\nPORT=8788\nDASHBOARD_PUBLIC_ORIGIN=http://192.168.1.10:3000\n'
  })
  expect(good.code, 'should accept strict origin: ' + good.err).toBe(0)
})

// ---- M1: validate_collector_binaries の provider 判定を bash で検証する ----
// 旧実装 `[[ ",${providers}" == *,codex,* ]]` では末尾/唯一 provider
// (例: "codex" 単独、"claude,codex")を検出できなかった。provider_list_has は
// カンマ分割 + trim したうえで正確に判定する。resolve_collector_bin_as_user は
// runuser を使わない stub(実 bin の -x 判定)で置き換えて挙動を検証する
// (実装は解決済み INSTALL_USER として runuser する。固定アカウント名は持たない)。

function runValidateBinaries(env: string): { code: number; err: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-bins-test-'))
  try {
    const envPath = path.join(dir, 'collector.env')
    fs.writeFileSync(envPath, env)
    const harness = [
      'set -euo pipefail',
      'log(){ :; }',
      'die(){ echo "die: $*" >&2; exit 1; }',
      extractBashFn('trim_leading_space'),
      extractBashFn('read_env_value'),
      extractBashFn('trim_space'),
      extractBashFn('provider_list_has'),
      'resolve_collector_bin_as_user() { local bin="$1"; [[ -x "$bin" ]]; }',
      extractBashFn('validate_collector_binaries'),
      'INSTALL_USER=tester',
      `validate_collector_binaries "${envPath}"`,
      'echo "BINS_OK"'
    ].join('\n')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const res = spawnSync('bash', [scriptPath], { encoding: 'utf8' })
    return { code: res.status ?? 1, err: res.stderr ?? '' }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** temp dir 内で実行可能 bin を作った path を返す */
function makeExecutableBin(dir: string, name: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(p, 0o755)
  return p
}

test('M1: validate_collector_binaries は codex 単独 / claude 単独を検出する', () => {
  // 末尾/唯一 provider を旧実装では検出できなかった回帰ケース
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-bins-codex-'))
  try {
    const codex = makeExecutableBin(dir, 'codex-bin')
    // claude 単独: CLAUDE_BIN だけ検証対象
    let res = runValidateBinaries(
      `COLLECTOR_PROVIDERS=claude\nCLAUDE_BIN=${makeExecutableBin(dir, 'claude-bin')}\n`
    )
    expect(res.code, res.err).toBe(0)
    // codex 単独: CODEX_BIN だけ検証対象
    res = runValidateBinaries(`COLLECTOR_PROVIDERS=codex\nCODEX_BIN=${codex}\n`)
    expect(res.code, res.err).toBe(0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('M1: validate_collector_binaries は codex,claude と前後空白値を trim して検出する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-bins-both-'))
  try {
    const codex = makeExecutableBin(dir, 'codex-bin')
    const claude = makeExecutableBin(dir, 'claude-bin')
    // 通常の 2 provider
    let res = runValidateBinaries(
      `COLLECTOR_PROVIDERS=codex,claude\nCODEX_BIN=${codex}\nCLAUDE_BIN=${claude}\n`
    )
    expect(res.code, res.err).toBe(0)
    // 前後空白 + 逆順: trim 後に正確に判定される(引用符は未対応のため die 対象)
    res = runValidateBinaries(
      `COLLECTOR_PROVIDERS= claude , codex \nCODEX_BIN=${codex}\nCLAUDE_BIN=${claude}\n`
    )
    expect(res.code, res.err).toBe(0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('M1: validate_collector_binaries は有効 provider の CLI 未検証を fail-closed にする', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-bins-deny-'))
  try {
    const claude = makeExecutableBin(dir, 'claude-bin')
    // codex 単独 + CODEX_BIN 空 -> die
    let res = runValidateBinaries(`COLLECTOR_PROVIDERS=codex\n`)
    expect(res.code).not.toBe(0)
    expect(res.err).toContain('CODEX_BIN is empty')
    // codex,claude + CLAUDE_BIN が実行不可能(存在しない) -> die
    res = runValidateBinaries(
      `COLLECTOR_PROVIDERS=codex,claude\nCODEX_BIN=${makeExecutableBin(dir, 'codex-bin')}\nCLAUDE_BIN=${path.join(dir, 'missing-claude')}\n`
    )
    expect(res.code).not.toBe(0)
    expect(res.err).toContain('CLAUDE_BIN is not an executable')
    // 無効 provider 側の CLI は検証されない( claude 無効なら CLAUDE_BIN 空でも OK)
    res = runValidateBinaries(
      `COLLECTOR_PROVIDERS=codex\nCODEX_BIN=${makeExecutableBin(dir, 'codex2')}\nCLAUDE_BIN=\n`
    )
    expect(res.code, res.err).toBe(0)
    void claude
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('M1: validate_collector_binaries は未知 provider を die で拒否する (allowed: codex, claude)', () => {
  // 旧実装は未知 provider を無視していたが、deploy 側でも実体として確定させるため
  // 未知名は current 切替前に fail-closed で die する(collector 側の resolveProviders
  // と同じ許可集合: codex, claude のみ)
  for (const bad of ['gemini', 'codex,gemini', 'Claude', 'gpt', 'codex gpt']) {
    const res = runValidateBinaries(`COLLECTOR_PROVIDERS=${bad}\n`)
    expect(res.code, `should die for provider "${bad}": ${res.err}`).not.toBe(0)
    expect(res.err).toContain('unknown provider')
  }
})

// ---- M1 回帰: COLLECTOR_MODE / COLLECTOR_PROVIDERS の入口検証 ----
// mode の typo・空・未知 provider・quoted provider・missing bin を die で拒否する。
// quoted provider: read_env_value は引用符を除去しないが systemd の EnvironmentFile
// は除去するため、検証値と systemd 値が食い違う引用符付き値を明示 die する。
test('M1 回帰: validate_collector_binaries は COLLECTOR_MODE の typo / 空を die で拒否する', () => {
  const real = makeExecutableBin(fs.mkdtempSync(path.join(os.tmpdir(), 'limit-mode-')), 'codex-bin')
  for (const bad of ['Real', 'REAL', 'real ', 'rel', '']) {
    const res = runValidateBinaries(
      `COLLECTOR_MODE=${bad}\nCOLLECTOR_PROVIDERS=codex\nCODEX_BIN=${real}\n`
    )
    expect(res.code, `should die for mode "${bad}": ${res.err}`).not.toBe(0)
    expect(res.err).toContain("COLLECTOR_MODE must be 'real' or 'mock'")
  }
  // 未指定(既定 real)と mock は従来どおり(未指定は CLI 検証 / mock はスキップ)
  const def = runValidateBinaries(`COLLECTOR_PROVIDERS=codex\nCODEX_BIN=${real}\n`)
  expect(def.code, def.err).toBe(0)
  const mock = runValidateBinaries(`COLLECTOR_MODE=mock\nCOLLECTOR_PROVIDERS=codex\n`)
  expect(mock.code, mock.err).toBe(0)
})

test('M1 回帰: validate_collector_binaries は空 / 未知 / 重複 provider を die で拒否する', () => {
  const real = makeExecutableBin(fs.mkdtempSync(path.join(os.tmpdir(), 'limit-prov-')), 'codex-bin')
  // real mode で COLLECTOR_PROVIDERS 未指定(空) -> 無効 provider が確定していないため die
  const empty = runValidateBinaries(`CODEX_BIN=${real}\n`)
  expect(empty.code).not.toBe(0)
  expect(empty.err).toContain('COLLECTOR_PROVIDERS is empty')
  // 空要素(先頭 / 末尾 / 中間の余分なカンマ) -> die
  for (const bad of [',codex', 'codex,', 'codex,,claude', ' ']) {
    const res = runValidateBinaries(`COLLECTOR_PROVIDERS=${bad}\nCODEX_BIN=${real}\n`)
    expect(res.code, `should die for providers "${bad}": ${res.err}`).not.toBe(0)
    expect(res.err).toContain('empty element')
  }
  // 重複(空白・順序違いを含めて trim 後の同一名で検出) -> die
  for (const bad of ['codex,codex', 'claude, codex, claude', 'claude,claude']) {
    const res = runValidateBinaries(`COLLECTOR_PROVIDERS=${bad}\nCODEX_BIN=${real}\n`)
    expect(res.code, `should die for providers "${bad}": ${res.err}`).not.toBe(0)
    expect(res.err).toContain('duplicate provider')
  }
})

test('M1 回帰: validate_collector_binaries は quoted provider を die で拒否する', () => {
  // parser は引用符を除去しないが systemd は除去する -> 検証値と systemd 値が
  // 食い違うため、引用符付き値は現れた時点で die(検証値と systemd 値を一致させる)
  const real = makeExecutableBin(
    fs.mkdtempSync(path.join(os.tmpdir(), 'limit-quote-')),
    'codex-bin'
  )
  for (const bad of ['"codex"', "codex,'claude'", '" codex "']) {
    const res = runValidateBinaries(
      `COLLECTOR_PROVIDERS=${bad}\nCODEX_BIN=${real}\nCLAUDE_BIN=${real}\n`
    )
    expect(res.code, `should die for quoted providers ${bad}: ${res.err}`).not.toBe(0)
    expect(res.err).toContain('COLLECTOR_PROVIDERS must not be quoted')
  }
  // 未引用の単一 provider は従来どおり受理(検出できない値の排除を意図した回帰)
  const ok = runValidateBinaries(`COLLECTOR_PROVIDERS=codex\nCODEX_BIN=${real}\n`)
  expect(ok.code, ok.err).toBe(0)
})

test('M1 回帰: validate_collector_binaries は missing bin を die で拒否する', () => {
  // 有効 provider の CLI が存在しない(未検証)まま current 切替をしない。
  // 対象 bin 以外の有効 provider の bin は実行可能な値を設定して、
  // 意図した die(存在しない bin)で検証が止まることを保証する
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-bins-missing-'))
  const real = makeExecutableBin(dir, 'codex-bin')
  const missing = path.join(dir, 'no-such-cli')
  try {
    for (const [providers, codexBin, claudeBin] of [
      ['codex', missing, real],
      ['claude', real, missing],
      ['codex,claude', real, missing]
    ] as const) {
      const res = runValidateBinaries(
        `COLLECTOR_PROVIDERS=${providers}\nCODEX_BIN=${codexBin}\nCLAUDE_BIN=${claudeBin}\n`
      )
      expect(res.code, `should die for missing bin (${providers}): ${res.err}`).not.toBe(0)
      expect(res.err).toContain('is not an executable')
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- B: resolve_collector_bin_as_user は絶対 path だけ受理する ----
// systemd unit の EnvironmentFile の値は PATH/CWD を信頼できないため、
// bare command(codex 等)と slash 付き相対 path(./codex、../bin/codex)は
// 受理しない。runuser を常に成功する stub に置き換え、実関数の
// 絶対 path 判定だけを検証する(初回の resolve_collector_cli_path が
// login shell の command -v で絶対 path を得て render するため、
// ここに流れてくる値は絶対 path であるべき)。
function runResolveBin(bin: string): { code: number; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-resolve-bin-'))
  try {
    const harness = [
      'set -euo pipefail',
      'runuser() { return 0; }',
      'INSTALL_USER=tester',
      extractBashFn('resolve_collector_bin_as_user'),
      `if resolve_collector_bin_as_user "${bin}"; then printf "ACCEPT\\n"; else printf "REJECT\\n"; fi`
    ].join('\n')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const res = spawnSync('bash', [scriptPath], { encoding: 'utf8' })
    return { code: res.status ?? 1, out: res.stdout ?? '' }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('B: resolve_collector_bin_as_user は絶対 path だけ受理、bare/相対は拒否', () => {
  // 絶対 path -> 受理(runuser stub が成功するため)
  expect(runResolveBin('/usr/local/bin/codex').out).toContain('ACCEPT')
  // bare command -> 拒否
  expect(runResolveBin('codex').out).toContain('REJECT')
  // slash 付き相対 path(./ と ../) -> 拒否
  expect(runResolveBin('./codex').out).toContain('REJECT')
  expect(runResolveBin('../bin/codex').out).toContain('REJECT')
  // 空値 -> 拒否
  expect(runResolveBin('').out).toContain('REJECT')
  // validate_collector_binaries も同様に bare/相対を die 相当で拒否する
  const bare = runValidateBinaries(`COLLECTOR_PROVIDERS=codex\nCODEX_BIN=codex\n`)
  expect(bare.code).not.toBe(0)
  expect(bare.err).toContain('CODEX_BIN must be an absolute path')
  const relative = runValidateBinaries(`COLLECTOR_PROVIDERS=claude\nCLAUDE_BIN=./claude\n`)
  expect(relative.code).not.toBe(0)
  expect(relative.err).toContain('CLAUDE_BIN must be an absolute path')
})

test('M2: ensure_env_install_dir は INSTALL_DIR を deploy 値へ整合 / 不一致は fail-closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-env-render-'))
  try {
    const harness = [
      'set -euo pipefail',
      'die(){ echo "die: $*" >&2; exit 1; }',
      'log(){ :; }',
      extractBashFn('read_env_value'),
      extractBashFn('install_if_missing_or_same'),
      extractBashFn('render_env_example'),
      extractBashFn('ensure_env_install_dir'),
      'INSTALL_DIR="__INSTALL_DIR__"',
      'ensure_env_install_dir "$1" "$2" 0644'
    ]
      .join('\n')
      .replaceAll('__INSTALL_DIR__', '/var/www/limit-monitor')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const examplePath = path.join(dir, 'x.env.example')
    // example は既定 INSTALL_DIR=/var/www/limit-monitor を書いてある想定
    fs.writeFileSync(examplePath, 'INSTALL_DIR=/var/www/limit-monitor\nOTHER=value\n')
    const dest = path.join(dir, 'x.env')

    // 1) 新規 + 既定 INSTALL_DIR -> render して配置(値はそのまま)
    let res = spawnSync('bash', [scriptPath, examplePath, dest], { encoding: 'utf8' })
    expect(res.status, res.stderr).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toContain('INSTALL_DIR=/var/www/limit-monitor')
    expect(fs.readFileSync(dest, 'utf8')).toContain('OTHER=value')

    // 2) 既存 env が INSTALL_DIR=別値 -> 非上書きで fail-closed(ファイルは不変)
    fs.writeFileSync(dest, 'INSTALL_DIR=/opt/limit-monitor\n')
    res = spawnSync('bash', [scriptPath, examplePath, dest], { encoding: 'utf8' })
    expect(res.status, 'should die on INSTALL_DIR mismatch: ' + res.stderr).not.toBe(0)
    expect(res.stderr).toContain('INSTALL_DIR')
    expect(fs.readFileSync(dest, 'utf8')).toContain('INSTALL_DIR=/opt/limit-monitor')

    // 3) 既存 env が INSTALL_DIR を持たない -> 非上書きで fail-closed
    fs.writeFileSync(dest, 'OTHER=value\n')
    res = spawnSync('bash', [scriptPath, examplePath, dest], { encoding: 'utf8' })
    expect(res.status, 'should die on missing INSTALL_DIR: ' + res.stderr).not.toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).not.toContain('INSTALL_DIR=/var/www')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('M5: validate_collector_token は非空・通常ファイル・安全な permission を要求し既存を上書きしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-token-'))
  try {
    const harness = [
      'set -euo pipefail',
      'die(){ echo "die: $*" >&2; exit 1; }',
      'log(){ :; }',
      extractBashFn('validate_collector_token'),
      'validate_collector_token'
    ].join('\n')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const etcDir = path.join(dir, 'etc')
    fs.mkdirSync(etcDir)

    const run = () =>
      spawnSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, LIMIT_MONITOR_ETC_DIR: etcDir }
      })
    const tokenPath = path.join(etcDir, 'collector-token')

    // 1) token 無い -> die(既存を上書きしない)
    expect(run().status, 'missing token must die').not.toBe(0)
    expect(fs.existsSync(tokenPath)).toBe(false)

    // 2) 空 token(trim 後空) -> die
    fs.writeFileSync(tokenPath, '   \n')
    fs.chmodSync(tokenPath, 0o600)
    let r = run()
    expect(r.status, 'empty token must die: ' + r.stderr).not.toBe(0)
    expect(r.stderr).toContain('empty')

    // 3) world-writable(mode 0666) -> die
    fs.writeFileSync(tokenPath, 'secret-token\n')
    fs.chmodSync(tokenPath, 0o666)
    r = run()
    expect(r.status, 'world-writable token must die: ' + r.stderr).not.toBe(0)
    expect(r.stderr).toContain('too-permissive')

    // 4) 通常ファイルで mode 0600 -> 受理
    fs.writeFileSync(tokenPath, 'secret-token\n')
    fs.chmodSync(tokenPath, 0o600)
    r = run()
    expect(r.status, 'valid token must pass: ' + r.stderr).toBe(0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('M1: rendered unit 検証(systemd-analyze verify)と既存 unit の upgrade 判定は current 切替前に fail-closed', () => {
  // rendered unit の検証(validate_rendered_units = systemd-analyze verify)と
  // 既存 unit の 管理(marker) / 非管理(手編集) upgrade 判定(check_managed_unit)
  // は unit 配置(install_managed_unit)より前に**読み取り専用**で呼ばれる。
  // 配置は current symlink 切替より前。順序を静的に確認する
  const idxValidateRendered = DEPLOY_SH.indexOf('validate_rendered_units\n')
  const idxCheckManaged = DEPLOY_SH.indexOf(
    'check_managed_unit "${RENDERED_SYSTEMD_DIR}/${template}" "${SYSTEMD_DIR}/${template}"'
  )
  const idxInstall = DEPLOY_SH.indexOf(
    'install_managed_unit "${RENDERED_SYSTEMD_DIR}/${template}" "${SYSTEMD_DIR}/${template}"'
  )
  const idxSwap = DEPLOY_SH.indexOf('mv -T "${INSTALL_DIR}/.current.new" "${INSTALL_DIR}/current"')
  expect(idxValidateRendered).toBeGreaterThan(0)
  expect(idxCheckManaged, 'check_managed_unit call must be present pre-swap').toBeGreaterThan(0)
  expect(idxInstall, 'unit install must be present pre-swap').toBeGreaterThan(0)
  expect(idxSwap).toBeGreaterThan(0)
  expect(idxValidateRendered, 'rendered-unit validation before managed check').toBeLessThan(
    idxCheckManaged
  )
  expect(idxCheckManaged, 'managed check before install').toBeLessThan(idxInstall)
  expect(idxInstall, 'install before current swap').toBeLessThan(idxSwap)
  // systemd-analyze verify は warning ではなく fail-closed(die)
  expect(DEPLOY_SH).toContain('systemd-analyze verify failed for')
  expect(DEPLOY_SH).toContain('(not switching current)')
})

test('install-systemd: 全読み取り専用検証が完了してから配置(unit/env/user/state dir)に入る', () => {
  // 検証フェーズ(読み取り専用)→ 配置フェーズ(/etc への書き込み)の順序を
  // 静的に確認する。検証フェーズのいずれかが die した場合は配置フェーズ
  // に入る前に終了するため、/etc(systemd unit / env file / user / state dir)
  // への書き込みは行われない(fail-closed)。
  const validateStart = DEPLOY_SH.indexOf('# === 検証フェーズ(読み取り専用')
  const placementStart = DEPLOY_SH.indexOf('# === 配置フェーズ(全検証完了後のみ')
  expect(validateStart).toBeGreaterThan(0)
  expect(placementStart, 'placement phase must exist after validation phase').toBeGreaterThan(
    validateStart
  )
  // 検証フェーズの呼び出し(配置フェーズより前に呼ばれること)
  const prePlacementValidators = [
    'validate_rendered_units\n',
    'check_managed_unit "${RENDERED_SYSTEMD_DIR}/${template}" "${SYSTEMD_DIR}/${template}"',
    'validate_env_install_dir "${REPO_ROOT}/deploy/${env_name}.env.example" "${LIMIT_MONITOR_ETC_DIR}/${env_name}.env"',
    'validate_limit_monitor_state_dir\n',
    'validate_collector_token\n',
    'validate_collector_binaries \\',
    'validate_dashboard_cors \\'
  ]
  // 配置フェーズの呼び出し(全検証完了後に呼ばれること)
  const placementOps = [
    'ensure_systemd_state\n',
    'install_managed_unit "${RENDERED_SYSTEMD_DIR}/${template}" "${SYSTEMD_DIR}/${template}"',
    'install -m "${hub_env_mode}" "${HUB_ENV_FOR_DEPLOY}" "${LIMIT_MONITOR_ETC_DIR}/hub.env'
  ]
  for (const marker of prePlacementValidators) {
    const idx = DEPLOY_SH.indexOf(marker)
    expect(idx, `validation call must be present: ${marker.trim()}`).toBeGreaterThan(0)
    expect(idx, `must run before placement phase: ${marker.trim()}`).toBeLessThan(placementStart)
  }
  for (const marker of placementOps) {
    const idx = DEPLOY_SH.indexOf(marker, validateStart)
    expect(idx, `placement call must be present: ${marker.trim()}`).toBeGreaterThan(validateStart)
    expect(idx, `must run after all validations: ${marker.trim()}`).toBeGreaterThan(
      placementStart - 1
    )
  }
  // 配置フェーズでも既存 env / token は上書きしない
  expect(DEPLOY_SH).toContain('existing env is not overwritten')
  expect(DEPLOY_SH).toContain('missing collector token')
  expect(DEPLOY_SH).toContain('refusing to overwrite existing')
})

test('Minor 6: collector unit は Hub へ送信するため Hub が先に立ち上がる', () => {
  // 再起動時 Hub 先行を保証。Wants= を使うことで Hub 不在でも単体起動可能
  expect(directivesOf(COLLECTOR_UNIT)).toMatch(/After=.*limit-monitor-hub\.service/)
  expect(directivesOf(COLLECTOR_UNIT)).toMatch(/Wants=.*limit-monitor-hub\.service/)
})

// ---- env parser: duplicate key 検出の回帰テスト ----
// read_env_value は初出の値を返すが systemd の EnvironmentFile は最後勝ち
// (last-wins)なので、重複 key があると検証値と実行値が食い違う。
// env_file_has_duplicate_keys が重複 key を検出することを実挙動で確認する。
function runDuplicateKeyCheck(envContent: string): { code: number; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-dupkey-test-'))
  try {
    const envPath = path.join(dir, 'hub.env')
    fs.writeFileSync(envPath, envContent)
    const harness = [
      'set -euo pipefail',
      extractBashFn('trim_leading_space'),
      'die(){ echo "die: $*" >&2; exit 1; }',
      extractBashFn('env_file_has_duplicate_keys'),
      `if dup="$(env_file_has_duplicate_keys "${envPath}")"; then`,
      '  printf "DUP:%s\\n" "$dup"',
      'else',
      '  printf "NODUP\\n"',
      'fi'
    ].join('\n')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const res = spawnSync('bash', [scriptPath], { encoding: 'utf8' })
    return { code: res.status ?? 1, out: res.stdout ?? '' }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('env parser: 重複 key は key 名付きで検出される(初回読み取りと systemd 後勝ちの差異を防ぐ)', () => {
  // 重複あり: key 名を stdout で出す(0 終了)
  const dup = runDuplicateKeyCheck('PORT=3000\nHOST=127.0.0.1\nPORT=4000\n')
  expect(dup.code, 'duplicate key must be detected').toBe(0)
  expect(dup.out).toContain('DUP:PORT')
  // 重複なし: 1 終了で検出されない
  const ok = runDuplicateKeyCheck('PORT=3000\nHOST=127.0.0.1\n')
  expect(ok.code).toBe(0)
  expect(ok.out).toContain('NODUP')
})

test('env parser: 改行なしの最終行に重複 key がある場合も検出する', () => {
  // 最終行 "PORT=4000" に改行がない場合、read は非ゼロ終了で loop を抜ける。
  // `while IFS= read -r line || [[ -n "$line" ]]` により最終行も 1 回処理される
  // ため、この重複も検出されなければならない(従来実装は最終行を落としていた)
  const dup = runDuplicateKeyCheck('PORT=3000\nHOST=127.0.0.1\nPORT=4000')
  expect(dup.code, 'duplicate key on final line without newline must be detected').toBe(0)
  expect(dup.out).toContain('DUP:PORT')
  // 改行なし最終行が重複 key でない場合は検出されない
  const ok = runDuplicateKeyCheck('PORT=3000\nHOST=127.0.0.1')
  expect(ok.code).toBe(0)
  expect(ok.out).toContain('NODUP')
})

// ---- 初回 install の collector.env: pre-rendered temp が配置対象(Major 1 回帰) ----
// 検証フェーズ(4a)は解決済み install user 環境で解決した CLI path を temp
// collector.env(RENDERED_ENV_DIR)へ render して検証する。配置フェーズは
// その render 済み temp を**そのまま**(byte-for-byte)配置する。固定 example
// を再 render して配置すると検証で通った CLI path が失われる(検証値と配置値
// の byte-for-byte 不一致)ため、配置結果 == render temp とすることを確認する。
function runCollectorEnvPlacement(opts: { example: string; rendered: string }): {
  code: number
  err: string
  placed: string
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-monitor-collector-env-place-'))
  let placed = ''
  try {
    const examplePath = path.join(dir, 'collector.env.example')
    const renderedPath = path.join(dir, 'rendered-collector.env')
    const dest = path.join(dir, 'collector.env')
    fs.writeFileSync(examplePath, opts.example)
    fs.writeFileSync(renderedPath, opts.rendered)
    const harness = [
      'set -euo pipefail',
      'log(){ :; }',
      'die(){ echo "die: $*" >&2; exit 1; }',
      extractBashFn('trim_leading_space'),
      extractBashFn('read_env_value'),
      extractBashFn('render_env_example'),
      extractBashFn('install_if_missing_or_same'),
      extractBashFn('ensure_env_install_dir'),
      'INSTALL_DIR="/var/www/limit-monitor"',
      // 配置フェーズの初回 install 呼び出しと同じ 4 引数形式(rendered 指定)
      `ensure_env_install_dir "${examplePath}" "${dest}" 0640 "${renderedPath}"`,
      'echo "PLACED_OK"'
    ].join('\n')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const res = spawnSync('bash', [scriptPath], { encoding: 'utf8' })
    if (fs.existsSync(dest)) {
      placed = fs.readFileSync(dest, 'utf8')
    }
    return { code: res.status ?? 1, err: res.stderr ?? '', placed }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('初回 collector.env: pre-rendered temp が配置対象で、固定 example と byte-for-byte 不一致', () => {
  // 固定 example: 実環境に無い /usr/local/bin/... の固定 CLI path
  const example = [
    'INSTALL_DIR=/var/www/limit-monitor',
    'HUB_URL=http://127.0.0.1:8787',
    'COLLECTOR_MODE=real',
    'CODEX_BIN=/usr/local/bin/codex',
    'CLAUDE_BIN=/usr/local/bin/claude',
    ''
  ].join('\n')
  // 検証フェーズで install user 環境の解決済み CLI path へ render 済み temp
  const rendered = example
    .replace('CODEX_BIN=/usr/local/bin/codex', 'CODEX_BIN=/home/collector/.local/bin/codex')
    .replace('CLAUDE_BIN=/usr/local/bin/claude', 'CLAUDE_BIN=/home/collector/.local/bin/claude')
  // pre-rendered temp は固定 example と byte-for-byte 等しくないこと
  //(配置対象が example だと検証で通った CLI path を失う = 回帰の本質)
  expect(rendered).not.toBe(example)

  const res = runCollectorEnvPlacement({ example, rendered })
  expect(res.code, res.err).toBe(0)
  // 配置ファイルは pre-rendered temp と byte-for-byte 一致
  expect(res.placed, 'placed collector.env must be the pre-rendered temp byte-for-byte').toBe(
    rendered
  )
  // 固定 example を(再 render して)配置したのではない
  expect(res.placed).not.toBe(example)
  expect(res.placed).toContain('CODEX_BIN=/home/collector/.local/bin/codex')
  expect(res.placed).toContain('CLAUDE_BIN=/home/collector/.local/bin/claude')
})

test('初回 collector.env: 配置フェーズは collector.env 未作成時のみ render temp をそのまま配置する', () => {
  // 配置フェーズの分岐: 未作成 -> 4 引数(rendered 指定)/ 既存 -> 従来どおり example
  const firstInstallCall =
    'ensure_env_install_dir "${REPO_ROOT}/deploy/collector.env.example" "${LIMIT_MONITOR_ETC_DIR}/collector.env" 0640 \\\n        "${RENDERED_ENV_DIR}/collector.env"'
  const existingCall =
    'ensure_env_install_dir "${REPO_ROOT}/deploy/collector.env.example" "${LIMIT_MONITOR_ETC_DIR}/collector.env" 0640\n'
  expect(DEPLOY_SH).toContain(firstInstallCall)
  expect(DEPLOY_SH).toContain(existingCall)
  // 未作成判定の直後に render 指定の呼び出しが来る
  expect(DEPLOY_SH).toContain('if [[ ! -e "${LIMIT_MONITOR_ETC_DIR}/collector.env" ]]; then')
})

// ---- render_env_example: sed replacement injection 回帰テスト ----
// 従来実装は sed "s|^INSTALL_DIR=.*|INSTALL_DIR=${INSTALL_DIR}|" で INSTALL_DIR 行を
// 置換していたが、replacement 中の & は「マッチ全体」に展開されるため、正当な
// 絶対 path(/srv/a&b 等)が "INSTALL_DIR=/srv/aINSTALL_DIR=/var/...b" のように
// 壊れていた。新実装は bash の文字列操作で生成するため、render 出力は入力値
// と完全一致しなければならない。
function runRenderEnvExample(opts: { example: string; installDir: string }): {
  code: number
  err: string
  out: string
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-render-env-'))
  let out = ''
  try {
    const examplePath = path.join(dir, 'hub.env.example')
    const outPath = path.join(dir, 'rendered.env')
    fs.writeFileSync(examplePath, opts.example)
    const harness = [
      'set -euo pipefail',
      'log(){ :; }',
      'die(){ echo "die: $*" >&2; exit 1; }',
      `INSTALL_DIR="${opts.installDir}"`,
      extractBashFn('render_env_example'),
      `render_env_example "${examplePath}" "${outPath}"`,
      'echo "RENDER_OK"'
    ].join('\n')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const res = spawnSync('bash', [scriptPath], { encoding: 'utf8' })
    if (fs.existsSync(outPath)) {
      out = fs.readFileSync(outPath, 'utf8')
    }
    return { code: res.status ?? 1, err: res.stderr ?? '', out }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('render_env_example: & / \\ / | を含む INSTALL_DIR 値も render 出力が入力値と完全一致', () => {
  const example = [
    '# comment (must not be a target)',
    '#INSTALL_DIR=comment line must not change',
    'INSTALL_DIR=/var/www/limit-monitor',
    'PORT=8787',
    ''
  ].join('\n')
  // sed replacement metacharacter(& = マッチ全体 / \ = エスケープ / | = 区切り)
  // を含む正当な絶対 path 群
  const installDirs = ['/srv/a&b', '/opt/lim\\it|x', '/srv/a&b/lim\\it|x']
  for (const installDir of installDirs) {
    const expected = example
      .split('\n')
      .map((line) =>
        line === 'INSTALL_DIR=/var/www/limit-monitor' ? `INSTALL_DIR=${installDir}` : line
      )
      .join('\n')
    const res = runRenderEnvExample({ example, installDir })
    expect(res.code, `render must succeed for ${installDir}: ${res.err}`).toBe(0)
    // 出力が INPUT 値と完全一致(=& 展開 / バックslash 食 / 区切り分裂が起きない)
    expect(res.out, `render output must equal input for ${installDir}`).toBe(expected)
  }
  // render_env_example は sed 置換経路を通さない(静的回帰ガード)
  const fn = extractBashFn('render_env_example')
  expect(fn).not.toMatch(/sed\s/)
})

// ---- install_managed_unit の実挙動: atomic temp は destination 同 filesystem ----
// 従来の実装は /tmp(別 filesystem)に temp を作り mv で配置していたが、
// filesystem を跨ぐ mv は copy + unlink で atomic ではない(中断時に不完全 unit)。
// 新実装は mktemp "${dest_parent}/.limit-unit.XXXXXX" で destination の
// parent(/etc/systemd/system 相当)に temp を作り、chmod 後 mv -T(同 dir rename)
// で配置する。既存 backup(.bak-<UTC timestamp>)と rollback 経路は維持する。
function runInstallManagedUnit(opts: { src: string; existing?: string; expectBackup?: boolean }): {
  code: number
  err: string
  destContent: string
  backupContents: string[]
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-unit-install-'))
  const marker = '# limit-monitor: managed by deploy/deploy.sh -- do not edit (edit env instead)'
  let destContent = ''
  let backupContents: string[] = []
  try {
    const srcPath = path.join(dir, 'limit-monitor-hub.service')
    const destParent = path.join(dir, 'systemd')
    fs.mkdirSync(destParent)
    const dest = path.join(destParent, 'limit-monitor-hub.service')
    fs.writeFileSync(srcPath, opts.src)
    if (opts.existing !== undefined) {
      fs.writeFileSync(dest, opts.existing)
    }
    const harness = [
      'set -euo pipefail',
      'log(){ :; }',
      'die(){ echo "die: $*" >&2; exit 1; }',
      `MANAGED_UNIT_MARKER="${marker}"`,
      extractBashFn('install_managed_unit'),
      `install_managed_unit "${srcPath}" "${dest}" 0644`,
      'echo "INSTALL_OK"'
    ].join('\n')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const res = spawnSync('bash', [scriptPath], { encoding: 'utf8' })
    if (fs.existsSync(dest)) {
      destContent = fs.readFileSync(dest, 'utf8')
    }
    if (opts.expectBackup) {
      for (const name of fs.readdirSync(destParent)) {
        if (name.startsWith('limit-monitor-hub.service.bak-')) {
          backupContents.push(fs.readFileSync(path.join(destParent, name), 'utf8'))
        }
      }
    }
    return { code: res.status ?? 1, err: res.stderr ?? '', destContent, backupContents }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('install_managed_unit: atomic temp は destination 同一 dir で作られ、backup 付きで更新される', () => {
  const marker = '# limit-monitor: managed by deploy/deploy.sh -- do not edit (edit env instead)'
  const v2 = '[Unit]\nDescription=limit hub (v2)\n[Service]\nExecStart=/usr/bin/node x\n'
  const v3 = '[Unit]\nDescription=limit hub (v3)\n[Service]\nExecStart=/usr/bin/node x\n'
  // 新規配置: dest 同一 dir に配置され marker が付加される
  const fresh = runInstallManagedUnit({ src: v2 })
  expect(fresh.code, fresh.err).toBe(0)
  expect(fresh.destContent.startsWith(marker)).toBe(true)
  expect(fresh.destContent).toContain('(v2)')

  // 内容変更: 旧管理 unit からの upgrade -> backup(.bak-<UTC ts>)が残る + atomic 更新
  const changed = runInstallManagedUnit({
    src: v3,
    existing: marker + '\n' + v2,
    expectBackup: true
  })
  expect(changed.code, changed.err).toBe(0)
  expect(
    changed.backupContents,
    'previous managed unit must be backed up before update'
  ).toHaveLength(1)
  // backup は旧内容(v2)、配置先は新内容(v3)
  expect(changed.backupContents[0]).toContain('(v2)')
  expect(changed.backupContents[0]).not.toContain('(v3)')
  expect(changed.destContent).toContain('(v3)')
  expect(changed.destContent).not.toContain('(v2)')

  // 非管理 unit(marker 無し)は上書きされず die
  const unmanaged = runInstallManagedUnit({
    src: v3,
    existing: '[Unit]\nDescription=hand edited\n'
  })
  expect(unmanaged.code).not.toBe(0)
  expect(unmanaged.err).toContain('not a deploy-managed unit')
  // 非管理 unit は上書きされていない
  expect(unmanaged.destContent).toBe('[Unit]\nDescription=hand edited\n')
})

test('install_managed_unit: atomic temp は destination の parent(同 filesystem)に作る', () => {
  // /tmp 跨ぎ(別 filesystem の temp + mv)は atomic ではないため禁止。
  // atomic 配置用の temp は mktemp "${dest_parent}/.limit-unit.XXXXXX" で
  // destination と同じ dir に作成し、chmod 後に同一 dir へ mv -T で rename する。
  // 比較用の一時ファイル(existing/body)は読取専用で /tmp 使用を許す。
  expect(DEPLOY_SH).toContain('tmp="$(mktemp "${dest_parent}/.limit-unit.XXXXXX")"')
  const fn = extractBashFn('install_managed_unit')
  // 配置 temp の作成が /tmp を使わないこと(新規・更新の 2 分岐とも同一 dir)
  const tmpCreate = fn.match(/tmp="\$\(mktemp[^\n]*\)/g) ?? []
  expect(tmpCreate.length, 'placement temp creation(s) must be present').toBeGreaterThan(0)
  for (const create of tmpCreate) {
    expect(create).toContain('dest_parent')
    expect(create).not.toContain('/tmp')
  }
  // mode 設定後に同一 dir へ atomic rename(mv -T)
  expect(fn).toContain('chmod "$mode" "$tmp"')
  expect(fn).toContain('mv -T "$tmp" "$dest"')
  // dest_parent の導出が temp 作成より前
  expect(fn.indexOf('dest_parent="$(dirname "$dest")"')).toBeLessThan(
    fn.indexOf('mktemp "${dest_parent}/.limit-unit.XXXXXX"')
  )
})

// ---- validate_node_bin_not_under_home (Major 3) の実挙動 ----
// /home/* や /root/* 配下の node は ProtectHome=true の hub / dashboard unit
// から実行時にアクセス不能になるため current 切替前に拒否し、HOME 外
// (/usr/bin/node 等)は受理する。
// 判定は readlink -f で正規化(実体解決)してから行うため、HOME 外の symlink
// でも実体が /home/* や /root/* 配下なら拒否される。
function runNodeBinCheck(nodeBin: string): { code: number; err: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-nodebin-'))
  try {
    const harness = [
      'set -euo pipefail',
      'log(){ :; }',
      'die(){ echo "die: $*" >&2; exit 1; }',
      extractBashFn('validate_node_bin_not_under_home'),
      `validate_node_bin_not_under_home "${nodeBin}"`,
      'echo "NODEBIN_OK"'
    ].join('\n')
    const scriptPath = path.join(dir, 'harness.sh')
    fs.writeFileSync(scriptPath, harness)
    const res = spawnSync('bash', [scriptPath], { encoding: 'utf8' })
    return { code: res.status ?? 1, err: res.stderr ?? '' }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('validate_node_bin_not_under_home: /home と /root は拒否、HOME 外の node は受理', () => {
  // /home/<user>/... 配下 -> die
  const home = runNodeBinCheck('/home/collector/.nvm/versions/node/v22/bin/node')
  expect(home.code).not.toBe(0)
  expect(home.err).toContain('under a user HOME')
  // /root/... 配下 -> die
  const root = runNodeBinCheck('/root/.local/share/nodejs/node/bin/node')
  expect(root.code).not.toBe(0)
  expect(root.err).toContain('under a user HOME')
  // HOME 外 -> 受理(0 終了)
  const usr = runNodeBinCheck('/usr/bin/node')
  expect(usr.code, usr.err).toBe(0)
  const usrLocal = runNodeBinCheck('/usr/local/bin/node')
  expect(usrLocal.code, usrLocal.err).toBe(0)
  // deploy 時は current 切替前に DEPLOY_NODE_BIN に対して呼ばれること
  const idxCall = DEPLOY_SH.indexOf('validate_node_bin_not_under_home "${DEPLOY_NODE_BIN}"')
  const idxSwap = DEPLOY_SH.indexOf('mv -T "${INSTALL_DIR}/.current.new" "${INSTALL_DIR}/current"')
  expect(idxCall).toBeGreaterThan(0)
  expect(idxSwap).toBeGreaterThan(idxCall)
})

test('validate_node_bin_not_under_home: HOME 外の symlink でも実体が HOME 配下なら拒否', () => {
  // ユーザーの HOME 配下に実体の node ファイルを作り、HOME 外(/tmp)の
  // symlink から指す。symlink の path 自体は HOME 外なので旧実装(文字列
  // case)では受理されてしまうが、readlink -f で正規化した実体が HOME 配下
  // なら拒否される。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-nodebin-sym-'))
  const homeDir = fs.mkdtempSync(path.join(os.homedir(), '.limit-monitor-test-'))
  try {
    const realNode = path.join(homeDir, 'node')
    fs.writeFileSync(realNode, '#!/bin/bash\nexit 0\n')
    fs.chmodSync(realNode, 0o755)
    const binDir = path.join(dir, 'opt', 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    const symlink = path.join(binDir, 'node')
    fs.symlinkSync(realNode, symlink)
    // 実体 path 自体でも同じく拒否されること
    const byReal = runNodeBinCheck(realNode)
    expect(byReal.code, byReal.err).not.toBe(0)
    expect(byReal.err).toContain('under a user HOME')
    // HOME 外の symlink 経由でも実体解決されて拒否されること
    const bySymlink = runNodeBinCheck(symlink)
    expect(bySymlink.code, bySymlink.err).not.toBe(0)
    expect(bySymlink.err).toContain('under a user HOME')
    expect(bySymlink.err).toContain(realNode)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('validate_node_bin_not_under_home: HOME 外の node / HOME 外 symlink は受理', () => {
  // 実体が HOME 外の symlink /usr/bin/node は受理(0 終了)
  const usr = runNodeBinCheck('/usr/bin/node')
  expect(usr.code, usr.err).toBe(0)
  // /tmp 側の symlink -> /usr/bin/node(実体 HOME 外)も受理
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-nodebin-accept-'))
  try {
    const binDir = path.join(dir, 'bin')
    fs.mkdirSync(binDir)
    const symlink = path.join(binDir, 'node')
    fs.symlinkSync('/usr/bin/node', symlink)
    const viaSymlink = runNodeBinCheck(symlink)
    expect(viaSymlink.code, viaSymlink.err).toBe(0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- root deploy: npm ci/build を root で実行しない(回帰) ----
// --install-systemd は EUID=0 を要求するため、root 実行時は npm ci / npm build
// を root 権限で走らせない:
//   - EUID=0 かつ SUDO_USER 空 / あり(sudo 実行)のいずれも同一ポリシー:
//     既存 build artifacts + node_modules をそのまま使い、欠落は fail-closed で die
//   - 非 root: 従来どおり npm ci + npm build
// EUID は bash の readonly 変数で子プロセスでは上書きできないため、build
// セクションを抽出して ${EUID} を ${FAKE_EUID} へ置換し分岐ロジックを検証する。
// npm 呼び出し自体は sentinel npm shim(exit 0、呼び出しを記録)で観測する。
function runRootBuildPhase(opts: {
  sudoUser?: string
  withArtifacts: boolean
  withNodeModules: boolean
  fakeEuid: number
  skipNpmCi?: boolean
  /**
   * build manifest を fixture に置くかどうか。true なら fixture の
   * artifacts / node_modules 状態に対して write_build_manifest を実行
   * (deploy.sh 側の関数をそのまま抽出実行)して生成し、root 経路が
   * validate で「一致する manifest」を検証する。false なら manifest 不在
   * (root 経路は validate で fail-closed になる)。
   * non-root 経路では build セクション内で build 後に write_build_manifest
   * が走るため fixture 側の manifest は不要(無視される)。
   */
  withManifest?: boolean
  /** manifest 生成後に全 artifact(5 tree + node_modules)を改変する */
  tamperAll?: boolean
  /** manifest 生成後に指定 dist tree のみ改変する */
  tamperDir?: string
  /** manifest 生成後に node_modules のみ改変する */
  tamperNodeModules?: boolean
}): { code: number; out: string; err: string; npmCalls: string[]; runuserCalls: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-root-build-'))
  const binDir = path.join(dir, 'bin')
  fs.mkdirSync(binDir)
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo)
  fs.writeFileSync(path.join(repo, 'package.json'), '{}\n')
  // 本番リポジトリでは dist/ と node_modules/ は git 管理外。fixture にも
  // .gitignore を置いてコミットしないと、manifest(dist/ 配下)が untracked
  // として source digest に取り込まれ、書き込み後に digest が変わって
  // check_build_manifest が誤って不一致(非ゼロ)となる
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\nnode_modules/\n')
  // build manifest の digest 比較対象(lockfile)。write_build_manifest /
  // check_build_manifest は production dependency tree digest を算出するため、
  // package-lock.json が top-level production package(node_modules/<name>)を
  // 1 つ以上宣言し、node_modules にその実体が必要(compute_production_set)。
  // 空 `{}` では両関数とも fail-closed で die する
  fs.writeFileSync(
    path.join(repo, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0' },
          'node_modules/pkg-a': { version: '1.0.0' }
        }
      },
      null,
      2
    )}\n`
  )
  // git が使えるよう fixture は git repo として用意(manifest の source digest
  // は tracked files の現在ディスク内容で算出される)。commit 済みの安定な
  // tree を作り、manifest 書き込み後も tracked file を変更しないことで
  // digest が不変になる
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'limit-monitor',
    GIT_AUTHOR_EMAIL: 'limit-monitor@example.com',
    GIT_COMMITTER_NAME: 'limit-monitor',
    GIT_COMMITTER_EMAIL: 'limit-monitor@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null'
  }
  const gitFixture = (args: string[]): string => {
    const res = spawnSync('git', args, { encoding: 'utf8', env: gitEnv })
    if (res.status !== 0) {
      throw new Error(`git fixture failed (${args.join(' ')}): ${res.stderr}`)
    }
    return res.stdout ?? ''
  }
  gitFixture(['-c', 'init.defaultBranch=main', 'init', '-q', repo])
  gitFixture(['-C', repo, 'add', '-A'])
  gitFixture(['-C', repo, 'commit', '-q', '-m', 'initial'])

  const artifacts = [
    'packages/shared/dist/src/index.js',
    'packages/hub/dist/src/index.js',
    // Hub token CLI(bin/tokens.ts)の runtime import 先
    'packages/hub/dist/src/features/tokens/store.js',
    'packages/collector/dist/src/index.js',
    'packages/client/dist/public/index.html',
    'packages/client/dist/server/index.js',
    'packages/client/dist/server/static-server.js'
  ]
  // release へ stage される 5 directory tree(STAGED_DIST_DIRS = 4 dist tree +
  // packages/hub/drizzle)。artifact digest は tree 配下の**全ファイル**を対象
  // にするため、REQUIRED 6 ファイル以外に extra ファイルを 1 つ置く
  // (6 ファイルしか hash しない実装では検出できない改変を検出する)
  const distDirs = [
    'packages/shared/dist',
    'packages/hub/dist',
    'packages/hub/drizzle',
    'packages/collector/dist',
    'packages/client/dist'
  ]
  const writeNodeModules = () => {
    fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'node_modules', 'x'), 'x\n')
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg-a'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg-a', 'index.js'), 'module.exports = {}\n')
  }
  const writeDistTrees = () => {
    for (const a of artifacts) {
      fs.mkdirSync(path.join(repo, path.dirname(a)), { recursive: true })
      fs.writeFileSync(path.join(repo, a), 'x\n')
    }
    for (const d of distDirs) {
      const extra = path.join(repo, d, 'extra.txt')
      fs.mkdirSync(path.dirname(extra), { recursive: true })
      fs.writeFileSync(extra, `${d}\n`)
    }
  }
  const forEachFile = (root: string, fn: (file: string) => void) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, entry.name)
      if (entry.isDirectory()) {
        forEachFile(p, fn)
      } else {
        fn(p)
      }
    }
  }
  const tamperAllFiles = (root: string) => {
    forEachFile(root, (f) => fs.appendFileSync(f, 'tampered\n'))
  }
  if (opts.withNodeModules) writeNodeModules()
  if (opts.withArtifacts) writeDistTrees()
  if (opts.withManifest) {
    // manifest は「build 完了状態」(4 dist + node_modules)に対して
    // write_build_manifest を実行して生成する(deploy.sh 側の関数をそのまま
    // 抽出実行するため、digest は check_build_manifest が再計算する値と
    // 完全一致する)
    writeDistTrees()
    writeNodeModules()
    const writeHarness = [
      'set -euo pipefail',
      'log(){ :; }',
      'die(){ echo "die: $*" >&2; exit 1; }',
      `REPO_ROOT="${repo}"`,
      // write_build_manifest が manifest 出力先として参照する
      // (deploy.sh と同一の値: ${REPO_ROOT}/dist/.limit-monitor-build-manifest)
      `BUILD_MANIFEST_FILE="${repo}/dist/.limit-monitor-build-manifest"`,
      'VITE_HUB_BASE_URL=http://127.0.0.1:8787',
      extractBashFn('sha256_of_file'),
      extractBashFn('compute_tracked_source_digest'),
      extractBashFn('compute_tree_digest'),
      extractBashFn('compute_production_set'),
      extractBashFn('compute_production_tree_digest_at'),
      extractBashFn('compute_production_tree_digest'),
      extractBashFn('write_build_manifest', 'STAGED_DIST_DIRS=('),
      'write_build_manifest'
    ].join('\n')
    const writeScript = path.join(dir, 'write-manifest.sh')
    fs.writeFileSync(writeScript, writeHarness)
    const writeRes = spawnSync('bash', [writeScript], { encoding: 'utf8' })
    if (writeRes.status !== 0) {
      throw new Error(`write_build_manifest fixture failed: ${writeRes.stderr}`)
    }
    // manifest 書き込み後、fixture を要求された状態へ戻す(= manifest より
    // 新しい改変 / 削除、すなわち stale build)
    if (!opts.withArtifacts) {
      // index.html 以外の artifact を削除する(index.html は
      // check_build_manifest の current-artifact 計算が必要とするため
      // 保持。削除自体は staged tree digest で検出される)
      for (const a of artifacts) {
        if (a === 'packages/client/dist/public/index.html') continue
        fs.rmSync(path.join(repo, a), { force: true })
      }
    }
    if (!opts.withNodeModules) {
      fs.rmSync(path.join(repo, 'node_modules'), { recursive: true, force: true })
    }
    if (opts.tamperAll) {
      for (const d of distDirs) tamperAllFiles(path.join(repo, d))
      tamperAllFiles(path.join(repo, 'node_modules'))
    } else if (opts.tamperDir !== undefined) {
      tamperAllFiles(path.join(repo, opts.tamperDir))
    } else if (opts.tamperNodeModules) {
      tamperAllFiles(path.join(repo, 'node_modules'))
    }
  }
  const npmLog = path.join(dir, 'npm-calls.log')
  const npmShim = path.join(binDir, 'npm')
  fs.writeFileSync(npmShim, ['#!/bin/bash', `echo "npm $*" >> "${npmLog}"`, 'exit 0'].join('\n'))
  fs.chmodSync(npmShim, 0o755)
  // runuser shim: stale manifest 時の「SUDO_USER として --prepare-build を再実行」
  // 経路を捕捉する。呼び出しを記録した上で必ず失敗させることで、再実行後も
  // stale なら die する fail-closed 契約をそのまま検証する(実際の再実行は行わない)
  const runuserLog = path.join(dir, 'runuser-calls.log')
  const runuserShim = path.join(binDir, 'runuser')
  fs.writeFileSync(
    runuserShim,
    `#!/bin/bash\necho "runuser $*" >> "${runuserLog}"\necho "runuser: stub (fails by design)" >&2\nexit 1\n`
  )
  fs.chmodSync(runuserShim, 0o755)

  // deploy.sh から build セクションを抽出し、EUID を FAKE_EUID へ置換する。
  // マーカ行(# --- build ----...)は全行ダッシュのため、行の先頭からではなく
  // その行の末尾(改行)から抽出する
  const startMarker = '# --- build ---'
  const endMarker = '# --- staging ---'
  const startIdx = DEPLOY_SH.indexOf(startMarker)
  const endIdx = DEPLOY_SH.indexOf(endMarker)
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    throw new Error('build section markers not found in deploy.sh')
  }
  const startLineEnd = DEPLOY_SH.indexOf('\n', startIdx)
  if (startLineEnd < 0) throw new Error('build marker line end not found in deploy.sh')
  const buildSection = DEPLOY_SH.slice(startLineEnd + 1, endIdx).replace(
    /\$\{EUID\}/g,
    '${FAKE_EUID}'
  )
  const harness = [
    'set -euo pipefail',
    'log(){ :; }',
    'die(){ echo "die: $*" >&2; exit 1; }',
    // REPO_ROOT は build manifest の前段代入(BUILD_MANIFEST_FILE=...)が
    // 参照するため、抽出より前に定義する
    `REPO_ROOT="${repo}"`,
    // build manifest の helper 群は build セクションより前の section に
    // 定義されるため、抽出して含める(root 分岐は check_build_manifest を
    // 呼び、非 root 分岐は build 後に write_build_manifest を呼ぶ)。
    // BUILD_MANIFEST_FILE の代入行まで含める(関数内で参照する)。
    extractBashFn('sha256_of_file', 'BUILD_MANIFEST_FILE='),
    // read_env_value が内部で呼ぶ trim_leading_space(= build セクションより
    // 前の section に定義)も抽出しないと、manifest 値の読み取りが
    // "command not found" で空になる(vite_hub_base_url 欠落と誤判定される)
    extractBashFn('trim_leading_space'),
    extractBashFn('compute_tracked_source_digest'),
    extractBashFn('compute_tree_digest'),
    extractBashFn('read_env_value'),
    extractBashFn('compute_production_set'),
    extractBashFn('compute_production_tree_digest_at'),
    extractBashFn('compute_production_tree_digest'),
    extractBashFn('write_build_manifest', 'STAGED_DIST_DIRS=('),
    // validate_build_manifest は check_build_manifest(非 dying コア: 不一致は
    // return 1 のみ)に分解済み。die メッセージは build セクションの root
    // 分岐が持つため、抽出対象は check_build_manifest 側
    extractBashFn('check_build_manifest'),
    // root 分岐の stale manifest 再実行経路: SUDO_USER の passwd 解決
    // (deploy.sh 側関数をそのまま抽出。getent は fixture 用スタブで置き換える)
    extractBashFn('resolve_sudo_user_identity'),
    `FAKE_EUID=${opts.fakeEuid}`,
    opts.sudoUser === undefined ? 'unset SUDO_USER' : `SUDO_USER="${opts.sudoUser}"`,
    // deploy.sh 冒頭で初期化される再実行防止フラグ(build セクション抽出では
    // 含まれないため set -u 下で必ず定義する)
    'LIMIT_MONITOR_PREPARE_RETRY=0',
    // getent stub: SUDO_USER の passwd entry を fixture repo(存在する
    // ディレクトリ)の home で返す(resolve_sudo_user_identity の
    // 「存在する絶対 path home」チェックを通過させる)
    `getent(){ printf '${opts.sudoUser ?? 'alice'}:x:1000:1000:x:${repo}:/bin/sh\\n'; }`,
    `SKIP_NPM_CI=${opts.skipNpmCi === false ? 0 : 1}`,
    'VITE_HUB_BASE_URL=http://127.0.0.1:8787',
    buildSection,
    'echo "BUILD_PHASE_DONE"'
  ].join('\n')
  const scriptPath = path.join(dir, 'harness.sh')
  fs.writeFileSync(scriptPath, harness)
  const res = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  })
  const npmCalls = fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8').trim().split('\n') : []
  const runuserCalls = fs.existsSync(runuserLog)
    ? fs.readFileSync(runuserLog, 'utf8').trim().split('\n')
    : []
  fs.rmSync(dir, { recursive: true, force: true })
  return {
    code: res.status ?? 1,
    out: res.stdout ?? '',
    err: res.stderr ?? '',
    npmCalls,
    runuserCalls
  }
}

test('root deploy: EUID=0 かつ SUDO_USER 空は npm ci/build を実行せず、artifacts 欠落は die', () => {
  // root 経路は build スキップ前に check_build_manifest が走る(新增 manifest
  // 仕様)。happy path は「非 root build 直後に生成された manifest が現 source と
  // 一致する」状態を再現する: artifacts + node_modules + manifest すべて揃う
  // -> npm なしで続行
  const ok = runRootBuildPhase({
    sudoUser: undefined,
    withArtifacts: true,
    withNodeModules: true,
    withManifest: true,
    fakeEuid: 0
  })
  expect(ok.code, ok.err).toBe(0)
  expect(ok.out).toContain('BUILD_PHASE_DONE')
  expect(ok.npmCalls, 'npm must not be invoked when EUID=0 and SUDO_USER is empty').toHaveLength(0)
  // artifacts 欠落 -> fail-closed で die(npm を走らせない)
  // manifest 生成後に artifact が削除された(= stale build)ため、
  // check_build_manifest の artifact digest 比較が非ゼロとなり、root 分岐は
  // 「manifest は stale」で die する(旧 build を root へ採用しない)
  const missing = runRootBuildPhase({
    sudoUser: undefined,
    withArtifacts: false,
    withNodeModules: true,
    withManifest: true,
    fakeEuid: 0
  })
  expect(missing.code).not.toBe(0)
  expect(missing.err).toContain('build manifest is missing or stale')
  expect(missing.npmCalls).toHaveLength(0)
  // node_modules 欠落 -> fail-closed で die(npm ci を root で走らせない)
  // manifest も存在しないため、build スキップ直前の manifest 検証で
  // 先に die する(古い build を root へ採用しない fail-closed)
  const noNm = runRootBuildPhase({
    sudoUser: undefined,
    withArtifacts: true,
    withNodeModules: false,
    fakeEuid: 0
  })
  expect(noNm.code).not.toBe(0)
  expect(noNm.err).toContain('build manifest is missing or stale')
  expect(noNm.npmCalls).toHaveLength(0)
})

test('root deploy: EUID=0 かつ SUDO_USER あり(sudo 実行)も npm を root で実行しない', () => {
  // artifacts + node_modules + 一致する manifest が存在 -> npm なしで続行
  // (新仕様: root 分岐は build スキップ前に check_build_manifest を実行)
  const ok = runRootBuildPhase({
    sudoUser: 'alice',
    withArtifacts: true,
    withNodeModules: true,
    withManifest: true,
    fakeEuid: 0
  })
  expect(ok.code, ok.err).toBe(0)
  expect(ok.out).toContain('BUILD_PHASE_DONE')
  expect(ok.npmCalls, 'npm must not be invoked as root even via sudo').toHaveLength(0)
  expect(ok.runuserCalls).toHaveLength(0)
  // 欠落は die(fail-closed)。artifacts / node_modules を manifest 生成後に
  // 削除すると stale build とみなされ、check_build_manifest が非ゼロとなる。
  // SUDO_USER ありの root 経路はそこで --prepare-build の再実行を試みるが、
  // 再実行(= npm)が成功しない限り die する(再実行後も stale のままなら
  // fail-closed。root は決して npm を実行しない)
  const missing = runRootBuildPhase({
    sudoUser: 'alice',
    withArtifacts: false,
    withNodeModules: false,
    withManifest: true,
    fakeEuid: 0
  })
  expect(missing.code).not.toBe(0)
  // 再実行経路が一度だけ試みられる(LIMIT_MONITOR_PREPARE_RETRY で 1 回限定)
  expect(
    missing.runuserCalls,
    'stale manifest with SUDO_USER must attempt exactly one --prepare-build re-run'
  ).toHaveLength(1)
  expect(missing.runuserCalls[0]).toContain('runuser -u alice')
  expect(missing.runuserCalls[0]).toContain('--prepare-build')
  // 再実行失敗は fail-closed で die する
  expect(missing.err).toContain('--prepare-build as alice failed')
  // 再実行は子プロセスとして runuser 経由で行われ、root の npm shim は
  // 一切呼ばれない(npm は決して root で実行しない)
  expect(missing.npmCalls).toHaveLength(0)
})

test('non-root deploy: 従来どおり npm ci + npm build が実行される', () => {
  const r = runRootBuildPhase({
    sudoUser: undefined,
    withArtifacts: true,
    withNodeModules: true,
    fakeEuid: 1000,
    skipNpmCi: false
  })
  expect(r.code, r.err).toBe(0)
  expect(r.out).toContain('BUILD_PHASE_DONE')
  expect(r.npmCalls).toContain('npm ci')
  expect(r.npmCalls).toContain('npm run build -w shared')
  expect(r.npmCalls).toContain('npm run build -w hub')
  expect(r.npmCalls).toContain('npm run build -w dashboard')
})

// ---- stale build 回帰: manifest 生成後の全 artifact 改変は必ず fail-closed ----
// build manifest は release へ stage する全 artifact(5 directory tree:
// 4 packages の dist + hub/drizzle、および root package.json/package-lock.json)
// + production dependencies(node_modules)の deterministic digest を固定する。
// manifest 生成後にいずれかが改変 / 不足すれば root 経路は
// check_build_manifest が非ゼロとなり「manifest は stale」で die し、
// 古い build を release しない。
test('stale build 回帰: 全 artifact(5 tree + node_modules)改変は root deploy で fail-closed', () => {
  // manifest は build 完了状態で生成 -> その後 全 dist tree + node_modules の
  // 全ファイルを改変(= 全 artifact を改変した stale build)。root 経路は
  // check_build_manifest が非ゼロ(= manifest と current tree の digest 不一致)
  // となって必ず die する
  const r = runRootBuildPhase({
    sudoUser: undefined,
    withArtifacts: true,
    withNodeModules: true,
    withManifest: true,
    tamperAll: true,
    fakeEuid: 0
  })
  expect(r.code, r.err).not.toBe(0)
  // 5 directory tree(4 dist + hub/drizzle)+ root package.json/package-lock.json
  // の全体 digest(artifact digest)または production node_modules digest の
  // いずれかの不一致で check が非ゼロとなり、root 分岐は stale と判定して die
  // (Dashboard index.html は packages/client/dist 配下として digest に入るため、
  // client/dist 改変もここで検出される)
  expect(r.err).toContain('build manifest is missing or stale')
  expect(r.npmCalls, 'npm must not be invoked on a stale build').toHaveLength(0)
})

test('stale build 回帰: 単一 dist tree の改変も root deploy で fail-closed', () => {
  // shared/dist のみ改変(他 dist と node_modules は build 状態のまま)でも
  // fail-closed になる(artifact digest は 5 directory tree 全体の path sort
  // digest であり、1 tree の改変でも必ず不一致になる)
  for (const tamperDir of [
    'packages/shared/dist',
    'packages/hub/dist',
    'packages/hub/drizzle',
    'packages/collector/dist',
    'packages/client/dist'
  ]) {
    const r = runRootBuildPhase({
      sudoUser: undefined,
      withArtifacts: true,
      withNodeModules: true,
      withManifest: true,
      tamperDir,
      fakeEuid: 0
    })
    expect(r.code, r.err).not.toBe(0)
    // 1 tree の改変でも check は非ゼロ(artifact digest 不一致)となり、
    // root 分岐は stale と判定して die する
    expect(r.err, `tampered ${tamperDir} must be detected`).toContain(
      'build manifest is missing or stale'
    )
    expect(r.npmCalls).toHaveLength(0)
  }
})

test('stale build 回帰: node_modules(production dependencies)改変は root deploy で fail-closed', () => {
  // dist artifacts は build 状態のまま node_modules のみ改変(= 本番依存の
  // 改変 / 不足)。root 経路は node_modules digest の比較で必ず die する
  const r = runRootBuildPhase({
    sudoUser: undefined,
    withArtifacts: true,
    withNodeModules: true,
    withManifest: true,
    tamperNodeModules: true,
    fakeEuid: 0
  })
  expect(r.code, r.err).not.toBe(0)
  // production node_modules digest の不一致で check が非ゼロとなり、
  // root 分岐は stale と判定して die する
  expect(r.err).toContain('build manifest is missing or stale')
  expect(r.npmCalls).toHaveLength(0)
})

test('root deploy: build / staging セクションの root 分岐に npm 呼び出しが無い(静的)', () => {
  const sectionBetween = (start: string, end: string): string => {
    const rest = DEPLOY_SH.split(start)[1]
    if (rest === undefined) throw new Error(`section start not found: ${start}`)
    const head = rest.split(end)[0]
    if (head === undefined) throw new Error(`section end not found: ${end}`)
    return head
  }
  const rootBranchOf = (section: string, branchMarker: string): string => {
    const tailPart = section.split(branchMarker)[1]
    if (tailPart === undefined) throw new Error(`branch marker not found: ${branchMarker}`)
    const beforeElse = tailPart.split('\nelse')[0]
    if (beforeElse === undefined) throw new Error(`else marker not found in: ${branchMarker}`)
    return beforeElse
  }
  const buildSection = sectionBetween('# --- build ---', '# --- staging ---')
  const buildRootBranch = rootBranchOf(buildSection, 'if [[ "${EUID}" -eq 0 ]]; then')
  const buildInvocations = buildRootBranch.split('\n').filter((l) => l.trim().startsWith('npm '))
  expect(
    buildInvocations,
    'no npm invocations in the root branch of the build section'
  ).toHaveLength(0)
  expect(buildRootBranch).toContain('cannot be run as root')
  expect(buildRootBranch).toContain('node_modules is missing')
  // 非 root 分岐は従来どおり npm ci + build を維持
  const buildNonRootBranch = buildSection.slice(buildSection.lastIndexOf('\nelse'))
  expect(buildNonRootBranch).toContain('npm ci')
  expect(buildNonRootBranch).toContain('npm run build -w shared')
  expect(buildNonRootBranch).toContain('npm run build -w dashboard')
  // staging セクション: root 分岐は npm ci の代わりに既存 node_modules を使う
  const stagingSection = sectionBetween('# --- staging ---', '# --- release ---')
  const stagingRootBranch = rootBranchOf(stagingSection, 'if [[ "${EUID}" -eq 0 ]]; then')
  const stagingInvocations = stagingRootBranch
    .split('\n')
    .filter((l) => l.trim().startsWith('npm '))
  expect(
    stagingInvocations,
    'no npm invocations in the root branch of the staging section'
  ).toHaveLength(0)
  // 新仕様: 旧 `cp -aL node_modules` の全体コピー(dev tree を release へ出す)は
  // 行わず、production-only tree を作り、manifest digest で検証してから配置する
  expect(stagingRootBranch).toContain(
    'build_staged_production_node_modules node_modules "${STAGE_DIR}/node_modules"'
  )
  expect(stagingRootBranch).not.toContain('cp -aL node_modules')
  // staging 後・release 変更前の production tree 検証(共通パス)
  const stagingVerify = sectionBetween('# --- staging ---', '# --- systemd 事前検証')
  expect(stagingVerify).toContain(
    'verify_staged_production_tree "${STAGE_DIR}/node_modules" "${BUILD_MANIFEST_FILE}"'
  )
  // artifacts 検証リストは共用(欠落判定と最終検証で同じ基準)
  expect(DEPLOY_SH).toContain('REQUIRED_BUILD_ARTIFACTS=(')
  expect(DEPLOY_SH).toContain('for artifact in "${REQUIRED_BUILD_ARTIFACTS[@]}"')
  // Hub token CLI: runtime import(dist/src/features/tokens/store.js)が
  // REQUIRED_BUILD_ARTIFACTS に入っている(import graph 最小範囲の drift 防止)
  const requiredParts = DEPLOY_SH.split('REQUIRED_BUILD_ARTIFACTS=(')
  if (requiredParts[1] === undefined) throw new Error('REQUIRED_BUILD_ARTIFACTS not found')
  const requiredList = requiredParts[1].split(/\n\)/)[0]
  if (requiredList === undefined) throw new Error('REQUIRED_BUILD_ARTIFACTS list not found')
  expect(requiredList).toContain('packages/hub/dist/src/features/tokens/store.js')
})

test('non-root staging: npm ci は --omit=dev のみで実行する(ignore-scripts なし、prepare_build と生成条件一致)', () => {
  const sectionBetween = (start: string, end: string): string => {
    const rest = DEPLOY_SH.split(start)[1]
    if (rest === undefined) throw new Error(`section start not found: ${start}`)
    const head = rest.split(end)[0]
    if (head === undefined) throw new Error(`section end not found: ${end}`)
    return head
  }
  // staging セクションの非 root 分岐(npm ci 実行経路)を抽出する
  const stagingSection = sectionBetween('# --- staging ---', '# --- release ---')
  const nonRootBranch = stagingSection.slice(stagingSection.lastIndexOf('\nelse'))
  // prepare_build の通常 `npm ci` は production 依存の lifecycle scripts を
  // 実行するため、staging の production tree も同じ条件(= --omit=dev のみ、
  // --ignore-scripts 付与なし)で生成しないと manifest の production tree
  // digest と staged tree が不一致になり得る。canonical 方式を揃える
  expect(nonRootBranch).toContain('( cd "${STAGE_DIR}" && npm ci --omit=dev )')
  expect(nonRootBranch).not.toContain('--ignore-scripts')
  // root 経路の filtered staging(build_staged_production_node_modules)と
  // verify(verify_staged_production_tree)は変更なし(維持)
  expect(nonRootBranch).not.toContain('build_staged_production_node_modules')
  expect(stagingSection).toContain(
    'verify_staged_production_tree "${STAGE_DIR}/node_modules" "${BUILD_MANIFEST_FILE}"'
  )
})

// ---- Hub token CLI staging 回帰 ------------------------------------------------
// docs/operations.md の契約: release の current/packages/hub/bin/tokens.ts を
// `node --experimental-strip-types` で直接起動する。そのため staging は
//   - bin/tokens.ts とその runtime import graph の先
//     (dist/src/config.js / dist/src/features/tokens/store.js /
//      dist/src/lib/database.js = packages/hub/bin + packages/hub/dist)
//   を必ず release へ含め、staging 済み tree で実行検証まで行う。
test('Hub token CLI: staging は bin/ を stage し、staged tree で tokens.ts を実行検証する', () => {
  // stage_package hub の呼び出しが bin を stage する(dist / drizzle と同じ行)
  expect(DEPLOY_SH).toContain('stage_package hub dist drizzle bin')
  // staging 後・release 変更前: staged tree で tokens.ts を実行検証する
  // (--help は DB 接続を行わない。import graph の全解決を確認する)
  const afterStaging = DEPLOY_SH.split('# --- staging ---')
  if (afterStaging[1] === undefined) throw new Error('staging section not found')
  const stagingVerifyParts = afterStaging[1].split('# --- systemd 事前検証')
  const stagingVerify = stagingVerifyParts[0]
  if (stagingVerify === undefined) throw new Error('systemd precheck section not found')
  expect(stagingVerify).toContain('node --experimental-strip-types packages/hub/bin/tokens.ts')
  expect(stagingVerify).toContain('staged token CLI entrypoint failed to run')
  // 既存の staged entrypoint 検証(hub app 等の import 解決)も維持
  expect(stagingVerify).toContain('./packages/hub/dist/src/app.js')
})

test('version directory: 既存 version は --force なしで拒否し、指定時だけ置換する', () => {
  const versionSection = DEPLOY_SH.split('VERSIONS_DIR="${INSTALL_DIR}/versions"')[1]
  if (versionSection === undefined) throw new Error('version directory section not found')
  const beforeLogs = versionSection.split('# --- release ---')[0]
  expect(beforeLogs).toContain(
    'version already exists: ${VERSION_DIR} (use --force to replace it explicitly)'
  )
  expect(beforeLogs).toContain('FORCE_VERSION')
  expect(DEPLOY_SH).toContain('--force) FORCE_VERSION=1')
  expect(DEPLOY_SH).toContain('VERSION_BACKUP_DIR="${VERSIONS_DIR}/.${VERSION_ID}.backup.$$"')
  expect(DEPLOY_SH).toContain('mv -T -- "${VERSION_DIR}" "${VERSION_BACKUP_DIR}"')
  expect(DEPLOY_SH).toContain('restore_version_backup')
  expect(DEPLOY_SH).toContain('FORCE_VERSION="${FORCE_VERSION:-0}"')
})

// ---- release dir mode 回帰 ---------------------------------------------------
// mktemp -d の STAGE_DIR は 0700。`cp -a "${STAGE_DIR}/." "${VERSION_DIR}/"` は
// 既存の VERSION_DIR へその 0700 mode を伝播させ、service user が current
// release を traverse できなくなる(Major)。release section は cp -a の属性
// 伝播に頼らず VERSION_DIR を明示 0755 に確定させる(再帰 chmod なし:
// release 内部の file/dirs は staging 側で既定の安全 mode で生成済み)。
test('release section: VERSION_DIR の mode は 0755 で確定する(cp -a 伝播なし / 再帰 chmod なし)', () => {
  const releaseSection = (() => {
    const rest = DEPLOY_SH.split('# --- release ---')[1]
    if (rest === undefined) throw new Error('release section not found')
    const head = rest.split('# --- systemd ---')[0]
    if (head === undefined) throw new Error('systemd section not found')
    return head
  })()
  // 親 versions/ と version dir の作成時に mode を明示する
  expect(releaseSection).toContain('install -d -m 0755 "${VERSIONS_DIR}"')
  expect(releaseSection).toContain('install -d -m 0755 "${VERSION_DIR}"')
  // cp -a の属性伝播(0700)を打ち消すため、copy 後に VERSION_DIR を 0755 に確定
  const copyIndex = releaseSection.indexOf('cp -a "${STAGE_DIR}/." "${VERSION_DIR}/"')
  if (copyIndex === -1) throw new Error('release copy not found')
  expect(releaseSection.slice(copyIndex)).toContain('chmod 0755 "${VERSION_DIR}"')
  // release 内部へ過度に広がらない: 再帰的な chmod は行わない
  expect(releaseSection).not.toMatch(/chmod\s+-R/)
  // owner は chown で変えない(既存の versions/current 設計: deploy 実行ユーザー)
  expect(releaseSection).not.toContain('chown')
})

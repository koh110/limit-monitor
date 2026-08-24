#!/usr/bin/env node
/**
 * Collector token の発行・失効・一覧 CLI。
 * 実行前に `npm run build -w hub` が必要(pretokens で自動実行される)。
 *
 * Usage:
 *   npm run tokens -w hub -- issue --source-id dev-machine --account-alias main
 *   npm run tokens -w hub -- revoke --source-id dev-machine --account-alias main
 *   npm run tokens -w hub -- list
 */
import { parseArgs } from 'node:util'
import { DB_FILE_PATH } from '../dist/src/config.js'
import { issueToken, listTokens, revokeToken } from '../dist/src/features/tokens/store.js'
import { createDb } from '../dist/src/lib/database.js'

const { values, positionals } = parseArgs({
  options: {
    'source-id': {
      type: 'string'
    },
    'account-alias': {
      type: 'string'
    },
    help: {
      type: 'boolean',
      short: 'h',
      default: false
    }
  },
  allowPositionals: true
})

function showHelp() {
  console.log(`Usage: tokens <command> [options]

Commands:
  issue --source-id <id> --account-alias <alias>   Issue (or reissue) a collector token
  revoke --source-id <id> --account-alias <alias>  Revoke the token for a sourceId + accountAlias
  list                                             List tokens and their states

Options:
  -h, --help  Show this help message

A token is bound to a sourceId + accountAlias pair. One sourceId can hold
multiple tokens with different accountAliases. The plaintext token is printed
only once on issue. Store it in the collector host's secret store
(systemd credentials / 1Password).`)
}

async function main() {
  const command = positionals[0]
  if (values.help || !command) {
    showHelp()
    return
  }

  const db = createDb(DB_FILE_PATH)

  if (command === 'issue') {
    const sourceId = requireOption('source-id')
    const accountAlias = requireOption('account-alias')
    const issued = await issueToken({ db, sourceId, accountAlias, now: new Date() })
    console.log(`sourceId:     ${issued.sourceId}`)
    console.log(`accountAlias: ${issued.accountAlias}`)
    console.log(`token:        ${issued.token}`)
    console.log('(this token is shown only once; only its hash is stored)')
    return
  }

  if (command === 'revoke') {
    const sourceId = requireOption('source-id')
    const accountAlias = requireOption('account-alias')
    const revoked = await revokeToken({ db, sourceId, accountAlias, now: new Date() })
    if (!revoked) {
      console.error(`no token found for sourceId: ${sourceId}, accountAlias: ${accountAlias}`)
      process.exitCode = 1
      return
    }
    console.log(`revoked: ${sourceId} (${accountAlias})`)
    return
  }

  if (command === 'list') {
    const tokens = await listTokens({ db })
    if (tokens.length === 0) {
      console.log('no tokens')
      return
    }
    for (const token of tokens) {
      const state = token.revokedAt ? `revoked at ${token.revokedAt}` : 'active'
      console.log(
        `${token.sourceId}\t${token.accountAlias}\tcreated at ${token.createdAt}\t${state}`
      )
    }
    return
  }

  console.error(`unknown command: ${command}`)
  showHelp()
  process.exitCode = 1
}

function requireOption(name: 'source-id' | 'account-alias'): string {
  const value = values[name]
  if (!value) {
    console.error(`--${name} is required`)
    process.exit(1)
  }
  return value
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

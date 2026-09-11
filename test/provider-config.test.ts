import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertNoDuplicateEnvKeys,
  installAtomic,
  normalizeProviders,
  readEnvValue,
  renderProviderEnv,
  renderProviderEnvFile
} from '../deploy/provider-config.ts'

test('normalizeProviders accepts known providers and preserves order', () => {
  assert.equal(normalizeProviders('grok,codex'), 'grok,codex')
})

test('normalizeProviders rejects empty, unknown, and duplicate providers', () => {
  assert.throws(() => normalizeProviders(''))
  assert.throws(() => normalizeProviders('codex,'))
  assert.throws(() => normalizeProviders('wat'), /unknown provider/)
  assert.throws(() => normalizeProviders('grok,grok'), /duplicate provider/)
})

test('readEnvValue ignores comments and leading whitespace', () => {
  const content = '# COLLECTOR_PROVIDERS=codex\n  COLLECTOR_PROVIDERS=grok\n'
  assert.equal(readEnvValue(content, 'COLLECTOR_PROVIDERS'), 'grok')
})

test('assertNoDuplicateEnvKeys fails closed on duplicate active keys', () => {
  assert.throws(
    () => assertNoDuplicateEnvKeys('COLLECTOR_PROVIDERS=codex\nCOLLECTOR_PROVIDERS=grok\n'),
    /duplicate env key: COLLECTOR_PROVIDERS/
  )
})

test('renderProviderEnv only replaces COLLECTOR_PROVIDERS and preserves unrelated content', () => {
  const before = [
    '# keep this comment',
    'COLLECTOR_MODE=real',
    'COLLECTOR_PROVIDERS=codex,claude',
    'SOURCE_ID=existing-host',
    'CODEX_BIN=/custom/codex',
    ''
  ].join('\n')
  const expected = [
    '# keep this comment',
    'COLLECTOR_MODE=real',
    'COLLECTOR_PROVIDERS=grok',
    'SOURCE_ID=existing-host',
    'CODEX_BIN=/custom/codex',
    ''
  ].join('\n')

  assert.equal(renderProviderEnv(before, 'grok'), expected)
})

test('renderProviderEnv appends the key when it is missing', () => {
  assert.match(
    renderProviderEnv('COLLECTOR_MODE=real\nSOURCE_ID=x\n', 'codex,grok'),
    /COLLECTOR_PROVIDERS=codex,grok/
  )
})

test('renderProviderEnvFile renders a candidate without mutating the source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-render-'))
  try {
    const source = path.join(dir, 'collector.env')
    const candidate = path.join(dir, 'candidate.env')
    const before = 'COLLECTOR_PROVIDERS=codex,claude\nSOURCE_ID=kept\n'
    fs.writeFileSync(source, before)

    renderProviderEnvFile(source, candidate, 'grok')

    assert.equal(fs.readFileSync(source, 'utf8'), before)
    assert.equal(fs.readFileSync(candidate, 'utf8'), 'COLLECTOR_PROVIDERS=grok\nSOURCE_ID=kept\n')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('installAtomic preserves existing mode and atomically replaces content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-install-'))
  try {
    const candidate = path.join(dir, 'candidate.env')
    const destination = path.join(dir, 'collector.env')
    fs.writeFileSync(candidate, 'COLLECTOR_PROVIDERS=grok\nSOURCE_ID=kept\n')
    fs.writeFileSync(destination, 'COLLECTOR_PROVIDERS=codex,claude\nSOURCE_ID=kept\n')
    fs.chmodSync(destination, 0o640)
    const mode = fs.statSync(destination).mode & 0o777

    installAtomic(candidate, destination)

    assert.equal(fs.readFileSync(destination, 'utf8'), 'COLLECTOR_PROVIDERS=grok\nSOURCE_ID=kept\n')
    assert.equal(fs.statSync(destination).mode & 0o777, mode)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

#!/usr/bin/env node
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:8788/' },
    output: { type: 'string', default: 'docs/assets/dashboard.png' },
    chromium: { type: 'string', default: '/snap/bin/chromium' },
    'wait-ms': { type: 'string', default: '5000' },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '1100' }
  }
})

function numberOption(name: string, value: string | undefined) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return parsed
}

async function runChromium(chromium: string, args: string[], timeout: number) {
  return execFileAsync(chromium, args, {
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    encoding: 'utf8'
  })
}

async function main() {
  const url = values.url
  const chromium = values.chromium
  const output = resolve(values.output)
  const waitMs = numberOption('wait-ms', values['wait-ms'])
  const width = numberOption('width', values.width)
  const height = numberOption('height', values.height)
  const timeout = Math.max(waitMs + 10_000, 30_000)
  const temporaryDirectory = await mkdtemp(join(resolve('.'), '.limit-monitor-screenshot-'))
  const domPath = join(temporaryDirectory, 'dashboard.html')
  const screenshotPath = join(temporaryDirectory, 'dashboard.png')
  const userDataDirectory = join(temporaryDirectory, 'chromium-profile')

  try {
    const chromiumArgs = [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-web-security',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      `--virtual-time-budget=${waitMs}`,
      '--run-all-compositor-stages-before-draw',
      `--user-data-dir=${userDataDirectory}`
    ]

    await runChromium(chromium, [...chromiumArgs, '--dump-dom', url], timeout).then(async ({ stdout }) => {
      await writeFile(domPath, stdout)
    })

    const dom = await readFile(domPath, 'utf8')
    if (!dom.includes('すべてのアカウントを更新')) {
      throw new Error('dashboard did not render the bulk refresh button')
    }
    if (!dom.includes('class="card"')) {
      throw new Error('dashboard did not render any account card; refusing to replace screenshot')
    }

    await runChromium(chromium, [...chromiumArgs, `--screenshot=${screenshotPath}`, url], timeout)
    const screenshot = await stat(screenshotPath)
    if (screenshot.size === 0) {
      throw new Error('chromium produced an empty screenshot')
    }

    await rename(screenshotPath, output)
    console.log(`Updated ${output} (${screenshot.size} bytes)`)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

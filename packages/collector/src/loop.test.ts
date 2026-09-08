import { expect, test } from 'vite-plus/test'
import { createCycleLoop } from './loop.js'

/** 実タイムラインで条件が成立するか deadline までポーリングする */
async function waitFor(condition: () => boolean, label: string, deadlineMs = 5000): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > deadlineMs) {
      throw new Error(`waitFor deadline exceeded: ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('前 cycle 完了後に次 cycle を schedule する(setInterval 方式でなく実行が重ならない)', async () => {
  const startedAt: number[] = []
  let inFlight = 0
  let maxInFlight = 0
  // cycle1 を明示的に解放する gate。cycle 実行(約 260ms)が interval(120ms)を超える
  const release: { current: (() => void) | null } = { current: null }
  const loop = createCycleLoop({
    intervalMs: 120,
    runCycle: async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      startedAt.push(Date.now())
      if (startedAt.length === 1) {
        await new Promise<void>((resolve) => {
          release.current = () => resolve()
        })
      }
      inFlight -= 1
    }
  })
  // cycle1 は ~120ms で開始し実行中(260ms > interval 120ms)
  await waitFor(() => startedAt.length === 1, 'cycle1 started')
  // 実行中に interval が 1 周(240ms)経過しても cycle2 は開始しない(非重複)
  await new Promise((resolve) => setTimeout(resolve, 160))
  expect(startedAt.length).toBe(1)
  expect(inFlight).toBe(1)
  // cycle1 を完了させる → 前 cycle 完了後に次 cycle を schedule し、
  // interval 120ms 経過で cycle2 が開始する
  const completedAt = Date.now()
  release.current?.()
  await waitFor(() => startedAt.length === 2, 'cycle2 started')
  const second = startedAt[1]
  expect(second).toBeGreaterThanOrEqual(completedAt + 100) // 完了後 + ほぼ 1 interval
  expect(second).toBeLessThan(completedAt + 400) // 直ちに積み上がって開始していない
  expect(maxInFlight).toBe(1) // 常に 1 件のみ実行されている
  loop.stop()
  await loop.done
})

test('runCycle の失敗はループを止めず次の cycle へ進み続ける', async () => {
  let calls = 0
  const loop = createCycleLoop({
    intervalMs: 100,
    runCycle: async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('transient failure')
      }
    }
  })
  // 失敗(cycle1)後も cycle2・cycle3 が開始し続ける
  await waitFor(() => calls >= 3, '3 cycles ran', 5000)
  loop.stop()
  await loop.done
  expect(calls).toBeGreaterThanOrEqual(3)
})

test('oneshot 契約を壊さない: intervalMs が 0 未満は reject する', () => {
  expect(() => createCycleLoop({ intervalMs: 0, runCycle: async () => {} })).toThrow(
    /positive intervalMs/
  )
  expect(() => createCycleLoop({ intervalMs: -1000, runCycle: async () => {} })).toThrow(
    /positive intervalMs/
  )
})

test('stop() は sleep 待ちを打ち切り done を解決させる', async () => {
  let ran = false
  const loop = createCycleLoop({
    intervalMs: 60_000,
    runCycle: async () => {
      ran = true
    }
  })
  loop.stop()
  await Promise.race([
    loop.done,
    new Promise((_, reject) => setTimeout(() => reject(new Error('done did not resolve')), 2000))
  ])
  expect(ran).toBe(false)
})

import type { Freshness } from './freshness.js'

export function calcRemainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent))
}

export type RemainingLevel = 'high' | 'medium' | 'low'

export function remainingLevel(remainingPercent: number): RemainingLevel {
  if (remainingPercent >= 50) {
    return 'high'
  }
  if (remainingPercent >= 20) {
    return 'medium'
  }
  return 'low'
}

export type DisplayTone = 'green' | 'yellow' | 'red' | 'gray' | 'darkgray'

const levelTone = {
  high: 'green',
  medium: 'yellow',
  low: 'red'
} as const

export function displayTone({
  freshness,
  remainingPercent
}: {
  freshness: Freshness
  remainingPercent: number | null
}): DisplayTone {
  if (freshness === 'never' || remainingPercent === null) {
    return 'darkgray'
  }
  if (freshness === 'stale' || freshness === 'expired') {
    return 'gray'
  }
  return levelTone[remainingLevel(remainingPercent)]
}

export function createGrokFixture(now: Date): unknown {
  const start = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000)
  return {
    config: {
      creditUsagePercent: 35,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: start.toISOString(),
        end: end.toISOString()
      }
    }
  }
}

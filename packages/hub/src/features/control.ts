import { randomUUID } from 'node:crypto'
import type { ControlMessage } from 'shared/src/control'

type Session = {
  sourceId: string
  accountAlias: string
  send: (message: ControlMessage) => boolean
}

export function createControlRegistry() {
  const sessions = new Map<string, Session>()
  return {
    register(session: Session) {
      const key = `${session.sourceId}:${session.accountAlias}`
      sessions.set(key, session)
      return () => {
        if (sessions.get(key) === session) sessions.delete(key)
      }
    },
    find(sourceId: string, accountAlias: string) {
      return sessions.get(`${sourceId}:${accountAlias}`)
    },
    sessions() {
      return sessions.values()
    },
    dispatch(session: Session, message: ControlMessage) {
      return session.send(message)
    }
  }
}

export function createPeriodicScheduler({
  intervalMs,
  dispatch
}: {
  intervalMs: number
  dispatch: (message: ControlMessage) => void
}) {
  let timer: ReturnType<typeof setInterval> | undefined
  function start() {
    if (timer) return
    timer = setInterval(() => dispatch({ type: 'collect', triggerId: randomUUID() }), intervalMs)
  }
  return {
    start,
    stop: () => {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  }
}

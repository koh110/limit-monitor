export type Prettify<T> = { [K in keyof T]: T[K] } & {}

type Success<T> = { ok: true; status: number; body: T }
type Failure<U = string> = { ok: false; status: number; body: U }
export type Result<T, U = string> = Success<T> | Failure<U>

export * from './contracts.js'
export * from './freshness.js'
export * from './remaining.js'
export * from './selection.js'

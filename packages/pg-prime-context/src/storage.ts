import { AsyncLocalStorage } from 'node:async_hooks'

/** The two members of `AsyncLocalStorage` the host uses; structural, so `@types/node` stays out of the `.d.ts`. */
export interface AsyncStorage<T> {
  getStore(): T | undefined
  run<R>(store: T, fn: () => R): R
}

export function newStorage<T>(): AsyncStorage<T> {
  return new AsyncLocalStorage<T>()
}

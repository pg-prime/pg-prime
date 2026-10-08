import type { HostTxOptions } from '@pg-prime/context'
import { DEFAULT, hostOf } from './tokens.js'

type Meta = {
  getOwnMetadataKeys?(t: object): unknown[]
  getOwnMetadata(k: unknown, t: object): unknown
  defineMetadata(k: unknown, v: unknown, t: object): void
}

/** Runs the async method in `host.transaction(…)`: the module's propagation unless `opts` overrides it. */
export function Transactional(opts: HostTxOptions & { connection?: string } = {}): MethodDecorator {
  const { connection = DEFAULT, ...tx } = opts
  const keys = new WeakMap<object, string | null>()
  return (_target, key, d) => {
    const fn = d.value as (...a: unknown[]) => Promise<unknown>
    const wrapped = async function (this: object, ...args: unknown[]) {
      return hostOf(this, connection, keys).transaction(() => fn.apply(this, args), {
        label: `${this.constructor.name}.${String(key)}`,
        ...tx,
      })
    }
    Object.defineProperty(wrapped, 'name', { value: fn.name })
    // Nest keeps route metadata on the function, so it must survive the swap.
    const R = Reflect as unknown as Meta
    for (const k of R.getOwnMetadataKeys?.(fn) ?? [])
      R.defineMetadata(k, R.getOwnMetadata(k, fn), wrapped)
    d.value = wrapped as never
  }
}

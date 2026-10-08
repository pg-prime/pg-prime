import { Inject } from '@nestjs/common'
import type { InjectionToken } from '@nestjs/common'
import { ContextError, TransactionHost } from '@pg-prime/context'

export const DEFAULT = 'default'

export function getDbToken(name: string = DEFAULT): InjectionToken {
  return `pg-prime:db:${name}`
}
/** The default name provides the `TransactionHost` class itself, so the bare type injects it. */
export function getHostToken(name: string = DEFAULT): InjectionToken {
  return name === DEFAULT ? TransactionHost : `pg-prime:host:${name}`
}
export const optionsToken = (name: string): string => `pg-prime:options:${name}`

export function InjectDb(name?: string): ParameterDecorator & PropertyDecorator {
  return Inject(getDbToken(name))
}
export function InjectHost(name?: string): ParameterDecorator & PropertyDecorator {
  return Inject(getHostToken(name))
}

const live = new Map<string, Set<TransactionHost>>()
const names = new WeakMap<TransactionHost, string>()

export function register(name: string, host: TransactionHost): () => void {
  const set = live.get(name) ?? new Set()
  live.set(name, set.add(host))
  names.set(host, name)
  return () => void set.delete(host)
}

/** The instance's own host under `name`, else the only live host registered under it. */
export function hostOf(
  self: object,
  name: string,
  keys: WeakMap<object, string | null>,
): TransactionHost {
  const o = self as Record<string, unknown>
  let key = keys.get(self.constructor)
  if (key === undefined) {
    const own = (k: string) =>
      o[k] instanceof TransactionHost && (names.get(o[k]) ?? DEFAULT) === name
    keys.set(self.constructor, (key = Object.keys(o).find(own) ?? null))
  }
  if (key !== null) return o[key] as TransactionHost
  const hosts = [...(live.get(name) ?? [])]
  if (hosts.length === 1) return hosts[0]!
  throw new ContextError(
    hosts.length ? 'CONTEXT_DUPLICATE_HOST' : 'CONTEXT_NOT_REGISTERED',
    hosts.length
      ? `${hosts.length} live apps registered a host named '${name}'; inject TransactionHost into ${self.constructor.name} so @Transactional uses its own.`
      : `no host named '${name}': import PgPrimeModule.forRoot({ name: '${name}' }), or inject TransactionHost into ${self.constructor.name}.`,
  )
}

import type { StandardSchemaV1 } from '@pg-prime/events'
import { PayloadError } from './errors.js'

export interface PayloadOptions<T> {
  /** Validates on both sides: before encoding and after decoding. */
  schema?: StandardSchemaV1<unknown, T>
  /** Maps the value to and from its JSON form. */
  codec?: { encode(v: T): unknown; decode(v: unknown): T }
}

export const MAX_PAYLOAD: number = 1024 * 1024
export const MAX_PROGRESS: number = 64 * 1024

/** Validates and encodes a payload, then serializes it. */
export async function encodePayload<T>(opts: PayloadOptions<T>, value: T): Promise<string> {
  const v = await validate(opts, value)
  return toJson(opts.codec === undefined ? v : opts.codec.encode(v), MAX_PAYLOAD, 'payload')
}

export function decodePayload<T>(opts: PayloadOptions<T>, wire: unknown): Promise<T> {
  return validate(opts, opts.codec === undefined ? (wire as T) : opts.codec.decode(wire))
}

/** JSON text for jsonb: refuses non-JSON values, NUL characters and oversize documents. */
export function toJson(value: unknown, maxBytes: number, what: string): string {
  const json = JSON.stringify(value) as string | undefined
  if (json === undefined) return 'null'
  const path = nulPath(value, [])
  if (path !== undefined) {
    throw new PayloadError(
      `@pg-prime/mq: the ${what} has a NUL character at ${fmt(path)}; jsonb cannot store it.`,
      path,
    )
  }
  const bytes = new TextEncoder().encode(json).length
  if (bytes > maxBytes) {
    throw new PayloadError(
      `@pg-prime/mq: the ${what} is ${bytes} bytes; the limit is ${maxBytes}. Store the document ` +
        `in a table and send its id.`,
    )
  }
  return json
}

async function validate<T>(opts: PayloadOptions<T>, value: unknown): Promise<T> {
  if (opts.schema === undefined) return value as T
  const r = await opts.schema['~standard'].validate(value)
  if (r.issues === undefined) return r.value
  const issue = r.issues[0]
  const path = (issue?.path ?? []).map((p) => (typeof p === 'object' ? p.key : p))
  throw new PayloadError(
    `@pg-prime/mq: the payload failed its schema at ${fmt(path)}: ${issue?.message ?? 'invalid'}`,
    path,
  )
}

function nulPath(v: unknown, path: PropertyKey[]): PropertyKey[] | undefined {
  if (typeof v === 'string') return v.includes('\0') ? path : undefined
  if (typeof v !== 'object' || v === null) return undefined
  for (const [k, x] of Object.entries(v)) {
    const key = Array.isArray(v) ? Number(k) : k
    if (k.includes('\0')) return [...path, key]
    const p = nulPath(x, [...path, key])
    if (p !== undefined) return p
  }
  return undefined
}

const fmt = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? '(root)' : path.map(String).join('.')

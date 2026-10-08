import { PayloadError } from './errors.js'

/** The Standard Schema v1 interface (standardschema.dev), copied as a type: no dependency. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>
    readonly types?: { readonly input: Input; readonly output: Output } | undefined
  }
}

export declare namespace StandardSchemaV1 {
  type Result<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | { readonly issues: readonly Issue[] }
  interface Issue {
    readonly message: string
    readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined
  }
}

export interface PayloadOptions<T> {
  /** Validates on both sides: before encoding and after decoding. */
  schema?: StandardSchemaV1<unknown, T>
  /** Maps the value to and from its JSON form. */
  codec?: { encode(v: T): unknown; decode(v: unknown): T }
}

const MAX_BYTES = 1024 * 1024

/** Validates, encodes and serializes a payload; refuses NUL characters and oversize documents. */
export async function encodePayload<T>(
  opts: PayloadOptions<T>,
  value: T,
  maxBytes: number = MAX_BYTES,
): Promise<string> {
  const v = await validate(opts, value)
  const wire = opts.codec === undefined ? v : opts.codec.encode(v)
  const json = JSON.stringify(wire) as string | undefined
  if (json === undefined) throw new PayloadError('@pg-prime/events: a payload must be JSON.')
  const path = nulPath(wire, [])
  if (path !== undefined) {
    throw new PayloadError(
      `@pg-prime/events: the payload has a NUL character at ${fmt(path)}; jsonb cannot store it.`,
      path,
    )
  }
  const bytes = new TextEncoder().encode(json).length
  if (bytes > maxBytes) {
    throw new PayloadError(
      `@pg-prime/events: the payload is ${bytes} bytes; the limit is ${maxBytes}. Store the ` +
        `document in a table and publish its id.`,
    )
  }
  return json
}

/** Decodes a JSON value read back from the database and validates it. */
export function decodePayload<T>(opts: PayloadOptions<T>, wire: unknown): Promise<T> {
  return validate(opts, opts.codec === undefined ? (wire as T) : opts.codec.decode(wire))
}

async function validate<T>(opts: PayloadOptions<T>, value: unknown): Promise<T> {
  if (opts.schema === undefined) return value as T
  const r = await opts.schema['~standard'].validate(value)
  if (r.issues === undefined) return r.value
  const issue = r.issues[0]
  const path = (issue?.path ?? []).map((p) => (typeof p === 'object' ? p.key : p))
  throw new PayloadError(
    `@pg-prime/events: the payload failed its schema at ${fmt(path)}: ${issue?.message ?? 'invalid'}`,
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

function fmt(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(root)' : path.map(String).join('.')
}

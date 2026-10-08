import { textCodec } from '../codec/index.js'
import type { AnyCodec, Codec, CodecOut, CodecPg } from '../codec/index.js'
import { UsageError } from '../errors/index.js'
import { sql } from '../sql/fragment.js'
import type { TypedFragment } from '../sql/fragment.js'
import { assertGucName } from './transaction.js'

/** A typed custom setting (GUC): one name for `setLocal` and for SQL that reads it. */
export interface SettingKey<T, P extends string = string> {
  readonly name: string
  readonly codec: Codec<T, unknown, P>
  /** `{ [name]: codec.encode(value) }`: spreads into `tx.setLocal({...})`, `session.set({...})`, `localSettings`. */
  set(value: T): Readonly<Record<string, string>>
  /** `nullif(current_setting('<name>', true), '')::<sqlName>`; NULL when unset or empty. */
  current(): TypedFragment<T | null, P>
}

export function setting(name: string): SettingKey<string, 'text'>
export function setting<C extends AnyCodec>(
  name: string,
  codec: C,
): SettingKey<CodecOut<C>, CodecPg<C>>
export function setting(name: string, codec: AnyCodec = textCodec): SettingKey<unknown> {
  assertGucName(name)
  const text = `nullif(current_setting('${name}', true), '')::${codec.sqlName}`
  // A one-chunk template object: the name is validated, so no bind and no `unsafeRaw` flag.
  const strings = Object.freeze(Object.assign([text], { raw: Object.freeze([text]) }))
  const current = sql(strings as unknown as TemplateStringsArray).as(codec)
  return Object.freeze({
    name,
    codec: codec as Codec<unknown, unknown, string>,
    set(value: unknown): Readonly<Record<string, string>> {
      const encoded = codec.encode(value as never)
      if (typeof encoded !== 'string') {
        throw new UsageError(
          `pg-prime: setting('${name}').set() needs a codec that encodes to text; ${codec.name} produced ${encoded === null ? 'NULL' : 'bytes'}.`,
        )
      }
      return Object.freeze({ [name]: encoded })
    },
    current: () => current as TypedFragment<unknown, string>,
  })
}

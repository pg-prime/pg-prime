# packages/pg-prime-events/src/payload.ts

## Purpose
Payload typing and checks shared by channels and topics: a copied Standard Schema v1 interface,
optional codec, JSON serialization, NUL and size checks. Called by `src/channel.ts` and `src/log/topic.ts`.

## Public API
- `StandardSchemaV1<Input, Output>` — the standardschema.dev interface, copied as a type (no dependency).
- `PayloadOptions<T>` — `{ schema?, codec? }`; `codec` maps to and from the JSON form.
- `encodePayload(opts, value, maxBytes = 1 MiB)` → JSON string; throws `PayloadError`. Internal.
- `decodePayload(opts, wire)` → `T`; codec decode then schema validation. Internal.

## Flow
1. `encodePayload` validates the value with the schema (`packages/pg-prime-events/src/payload.ts:40`).
2. Applies `codec.encode`, then `JSON.stringify`; `undefined` (a function) is refused (`:43`).
3. Walks the encoded value for `\u0000` in strings and keys, reporting the path (`:78`).
4. Refuses more than `maxBytes` UTF-8 bytes (`:52`).
5. `decodePayload` runs `codec.decode`, then the schema (`:62`).

## Gotchas
- Validation runs on both sides; a schema that rejects stored data makes a read fail (a reader
  treats it as a handler failure, so it is retried and parked).
- jsonb cannot store `\u0000`, which is why the NUL check exists.
- Channels pass `maxBytes = Infinity`; `db.notify` enforces PostgreSQL's 8000-byte limit itself.
- Only the first schema issue is reported; object path segments `{ key }` are flattened (`:71`).

## Tests
- `test/unit/payload.test.ts` — codec round trip, sync and async schemas, NUL paths, size and
  non-JSON values. `pnpm --filter @pg-prime/events test`.

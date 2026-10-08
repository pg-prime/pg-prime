# packages/pg-prime-mq/src/payload.ts

## Purpose
Payload, result and progress encoding: Standard Schema validation, codec, NUL and size checks.
Used by sends, flows, decoding claimed messages, completions and `ctx.progress`.

## Public API
- `PayloadOptions<T>` — `{ schema?, codec? }`.
- `encodePayload(opts, value)` → JSON text; `decodePayload(opts, wire)` → validated value.
- `toJson(value, maxBytes, what)` → JSON text; `undefined` becomes `null`.
- `MAX_PAYLOAD` (1 MiB, payloads and results), `MAX_PROGRESS` (64 KiB).

## Flow
1. Validate with the schema, then apply `codec.encode` (packages/pg-prime-mq/src/payload.ts:15).
2. `toJson` refuses a NUL in any string or key with its path, then the byte size (packages/pg-prime-mq/src/payload.ts:25).

## Gotchas
- Decoding validates too: a claimed message that fails decoding is failed at once by the worker.

## Tests
- `test/unit/define.test.ts`, `test/live/send.test.ts` (NUL path, size, schema). `pnpm --filter @pg-prime/mq test`.

# packages/pg-prime-outbox/src/sinks.ts

## Purpose
The two built-in sinks: `functionSink` (a function as a sink) and `webhookSink` (HTTP POST through
the global `fetch`).

## Public API
- `functionSink(fn)` → `{ deliver: fn }` (`packages/pg-prime-outbox/src/sinks.ts:5`).
- `webhookSink(opts)` → `OutboxSink<T>` (`packages/pg-prime-outbox/src/sinks.ts:31`).
- `WebhookSinkOptions` — `url` (string or per-record function), `mode` (`'record'` default |
  `'batch'`), `headers`, `timeoutMs` (10 000), `sign { secret, header? }`, `retryable(status)`.

## Flow
1. `groups` splits the wave: one group per record, or one per resolved URL in batch mode.
2. Each group is POSTed in parallel with `content-type: application/json`, `x-outbox-epoch`,
   `idempotency-key` (record mode only) and, with `sign`, a hex HMAC-SHA256 of the exact body.
3. The signal is `AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)])`; the response body
   is cancelled.
4. A non-2xx status throws `NonRetryableSinkError` unless `retryable(status)` (default 408, 425, 429,
   5xx); network errors and timeouts are plain (retryable) errors.
5. Every record of a failed group goes into `failed`; no failures resolve to `undefined`.

## Gotchas
- The body is `{ id, key, idem, payload, headers, createdAt }` with `id` as a string (JSON has no
  bigint) and `createdAt` ISO; batch mode sends an array of those.
- Batch mode sends no `Idempotency-Key`; receivers deduplicate on each item's `idem`.
- Header names are lower-cased, including a custom `sign.header`.

## Tests
- `packages/pg-prime-outbox/test/unit/webhook.test.ts` — against a local `node:http` server: headers,
  HMAC, batch grouping, the retryable status matrix, a custom `retryable`, timeout, partial failure.
  Runs on Node and on Bun.

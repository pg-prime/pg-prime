import { createHmac } from 'node:crypto'
import { NonRetryableSinkError } from './errors.js'
import type { DeliveryContext, DeliveryResult, OutboxRecord, OutboxSink } from './types.js'

export function functionSink<T>(
  fn: (wave: readonly OutboxRecord<T>[], ctx: DeliveryContext) => Promise<DeliveryResult>,
): OutboxSink<T> {
  return { deliver: fn }
}

export interface WebhookSinkOptions<T> {
  url: string | ((r: OutboxRecord<T>) => string)
  /** `'record'` (default): one POST per record. `'batch'`: one POST per URL with a JSON array. */
  mode?: 'batch' | 'record'
  headers?: Record<string, string>
  /** Default 10 000. */
  timeoutMs?: number
  /** HMAC-SHA256 of the body, hex, in `header` (default `X-Signature`). */
  sign?: { secret: string; header?: string }
  /** Default: 408, 425, 429 and 5xx. Any other non-2xx parks the record. */
  retryable?: (status: number) => boolean
}

const defaultRetryable = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500

/**
 * POSTs JSON with `Idempotency-Key` (record mode) and `X-Outbox-Epoch`, through the global
 * `fetch`.
 */
export function webhookSink<T>(opts: WebhookSinkOptions<T>): OutboxSink<T> {
  const { mode = 'record', timeoutMs = 10_000, retryable = defaultRetryable } = opts
  const urlOf = typeof opts.url === 'string' ? () => opts.url as string : opts.url

  const post = async (
    url: string,
    body: unknown,
    idem: string | undefined,
    ctx: DeliveryContext,
  ): Promise<void> => {
    const text = JSON.stringify(body)
    const headers: Record<string, string> = {
      ...opts.headers,
      'content-type': 'application/json',
      'x-outbox-epoch': String(ctx.epoch),
    }
    if (idem !== undefined) headers['idempotency-key'] = idem
    if (opts.sign !== undefined) {
      headers[(opts.sign.header ?? 'X-Signature').toLowerCase()] = createHmac(
        'sha256',
        opts.sign.secret,
      )
        .update(text)
        .digest('hex')
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: text,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
    })
    await res.body?.cancel()
    if (res.ok) return
    const msg = `webhook ${url} answered ${res.status}`
    throw retryable(res.status) ? new Error(msg) : new NonRetryableSinkError(msg)
  }

  const groups = (wave: readonly OutboxRecord<T>[]): OutboxRecord<T>[][] => {
    if (mode === 'record') return wave.map((r) => [r])
    const byUrl = new Map<string, OutboxRecord<T>[]>()
    for (const r of wave) byUrl.set(urlOf(r), [...(byUrl.get(urlOf(r)) ?? []), r])
    return [...byUrl.values()]
  }

  return {
    async deliver(wave, ctx) {
      const failed = new Map<bigint, unknown>()
      await Promise.all(
        groups(wave).map(async (g) => {
          try {
            const body = mode === 'record' ? bodyOf(g[0]!) : g.map(bodyOf)
            await post(urlOf(g[0]!), body, mode === 'record' ? g[0]!.idem : undefined, ctx)
          } catch (e) {
            for (const r of g) failed.set(r.id, e)
          }
        }),
      )
      return failed.size === 0 ? undefined : { failed }
    },
  }
}

const bodyOf = <T>(r: OutboxRecord<T>) => ({
  id: String(r.id),
  key: r.key,
  idem: r.idem,
  payload: r.payload,
  headers: r.headers,
  createdAt: r.createdAt.toISOString(),
})

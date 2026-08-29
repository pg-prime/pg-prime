/**
 * What `@types/pg` does and does not satisfy about the seam (design/02 §3, design/08 §8 #5).
 *
 * Compiled by `test/live/tsconfig.json`; nothing here runs. It exists because the claim "`pg.Pool`
 * is not nominally our `PgLikePool`, it merely has the right shape" is checked nowhere else, and
 * design/12 §4 D found two members where it had stopped being true:
 *
 *  - `PgLikeClient.on` / `.removeListener` declared their listener `(arg: never) => void`, and
 *    `EventEmitter`'s is `(...args: any[]) => void`. `any` is assignable to everything **except**
 *    `never`, so a `pg.PoolClient` failed to satisfy the seam and every call site inside the
 *    adapter carried an `as (a: never) => void` cast to compensate. Both are fixed.
 *  - `getTransactionStatus()` omitted `null`, which `@types/pg` declares and pg really returns
 *    before the first `ReadyForQuery`. Fixed.
 *
 * What is still NOT satisfied is recorded here rather than in a comment nobody runs: `@types/pg`
 * declares `QueryParse.types` as **`string[]`** (`@types/pg@8.21.0`, `index.d.ts:119`) where pg
 * passes OIDs as numbers, so `Connection.parse` cannot be made assignable to ours without writing
 * a declaration we know to be wrong. Until that is fixed upstream, `pgDriver({ pool })` needs the
 * documented `as unknown as PgLikePool` — which `test/live/_harness.ts` has always had.
 */

import type { Pool, PoolClient } from 'pg'
import type { PgLikeClient, PgLikePool, PgLikePoolClient } from '../../src/driver/pg-like.js'

declare const client: PoolClient
declare const pool: Pool

/** The listener members: this is the regression. */
const listeners: Pick<PgLikeClient, 'on' | 'removeListener'> = client
/** The transaction-status member: the second one. */
const status: Pick<PgLikeClient, 'getTransactionStatus'> = client
/** Everything on the client except `connection`, which is the residual below. */
const rest: Omit<PgLikePoolClient, 'connection'> = client

// The residual, pinned: with `connection` included it does NOT assign, and the reason is upstream.
// @ts-expect-error `@types/pg@8.21.0` types `QueryParse.types` as `string[]`; pg passes OIDs.
const whole: PgLikePool = pool

void [listeners, status, rest, whole]

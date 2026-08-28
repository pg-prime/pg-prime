/**
 * Session GUCs at connection setup (design/07 §3.6, decision 7 of design/12 §1).
 *
 * ## The defaults, and the one that is an opinion
 *
 * | GUC | Default | Why |
 * |---|---|---|
 * | `application_name` | `'pg-prime'` | Free, and the difference between a readable and an unreadable `pg_stat_activity` at 3 a.m. Nobody ships this; everybody wishes they had. |
 * | `statement_timeout` | **`30s`** | Unbounded is how an app hangs forever holding a connection. Generous enough that no normal OLTP query trips it, tight enough to bound the blast radius. Explicitly *not* Prisma's 5 s, which `research/prisma.md` records as a recurring production surprise. |
 * | `lock_timeout` | unset | A default here breaks legitimate queuing, and PG's own default is unset. The migrator is the opposite case and sets it aggressively. |
 * | `idle_in_transaction_session_timeout` | `60s` | The classic leak: an `await` on an HTTP call inside a transaction holds locks and blocks `VACUUM` indefinitely. Our own code cannot leak — `transaction()` always ends in a `finally` — but user code awaiting the network inside a callback can. |
 * | `TimeZone` | `UTC` | Our codecs are offset-driven, but `DateStyle`/`TimeZone` change the *text* we parse for several types. Pinning removes a whole class of environment-dependent bug. |
 *
 * ## And the part that is a genuine capability gap
 *
 * Under a transaction profile we **cannot** do any of this: a `SET` at connect lands on a server
 * connection PgBouncer will hand to another client, and transaction mode does not run
 * `server_reset_query` by default, so the setting leaks across tenants. So we do not emit it, we
 * say so once at `info`, and we name the operational fix (`ALTER ROLE … SET …`). Pretending
 * otherwise is exactly the Prisma #21799 failure mode.
 */

import type { PoolerProfile } from '../pooler/profiles.js'
import type { Duration, SessionDefaults } from './types.js'

/** `250` → `'250ms'`; `'30s'` → `'30s'`. A bare number in a GUC is milliseconds for the timeouts. */
function duration(v: Duration): string {
  return typeof v === 'number' ? `${v}ms` : v
}

export interface ResolvedSessionSettings {
  /** `[name, value]` pairs to apply. Empty under a transaction profile. */
  readonly settings: readonly (readonly [string, string])[]
  /** Names we would have applied but did not, for the one `info` line and for `diagnose()`. */
  readonly skipped: readonly string[]
}

/**
 * `07` §3.6's table, resolved against the caller's overrides and the pooler profile.
 *
 * `null` disables a default explicitly, which is different from omitting it — that is why every
 * field is `Duration | null` and not `Duration | undefined`.
 */
export function resolveSessionSettings(
  session: SessionDefaults | undefined,
  profile: PoolerProfile,
): ResolvedSessionSettings {
  const wanted: [string, string][] = []
  const push = (
    name: string,
    value: Duration | string | null | undefined,
    fallback: string | null,
  ): void => {
    const v = value === undefined ? fallback : value
    if (v === null) return
    wanted.push([name, duration(v)])
  }

  push('application_name', session?.applicationName, 'pg-prime')
  push('statement_timeout', session?.statementTimeout, '30s')
  push('lock_timeout', session?.lockTimeout, null)
  push('idle_in_transaction_session_timeout', session?.idleInTransactionSessionTimeout, '60s')
  push('TimeZone', session?.timeZone, 'UTC')
  if (session?.searchPath !== undefined && session.searchPath.length > 0) {
    wanted.push(['search_path', session.searchPath.join(', ')])
  }

  if (profile.sessionGucsAtConnect === 'unsafe') {
    return { settings: EMPTY, skipped: wanted.map(([n]) => n) }
  }
  return { settings: wanted, skipped: EMPTY_NAMES }
}

const EMPTY: readonly (readonly [string, string])[] = Object.freeze([])
const EMPTY_NAMES: readonly string[] = Object.freeze([])

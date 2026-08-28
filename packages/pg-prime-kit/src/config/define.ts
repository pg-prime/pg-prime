/**
 * `pg-prime.config.ts`.
 *
 * design/11 §1.2: `defineConfig` lives in `@pg-prime/kit`, not in `pg-prime`. The config
 * describes the *kit's* inputs — migrations directory, shadow strategy, database URL —
 * and the runtime package must not know the CLI's option surface. This is drizzle-kit's
 * model, and the same argument as design/08 §1.1's split.
 */

import type { ConnInfo } from "../db/pg.js";

import type { ShadowStrategy } from "../shadow/ladder.js";

export interface PgPrimeConfig {
  /**
   * The database every command connects to. A `postgres://` / `postgresql://` URL, or a
   * `ConnInfo`. Overridden by `--url`; falls back to `PG_PRIME_DATABASE_URL` and then
   * `DATABASE_URL` when absent.
   */
  readonly url?: string;
  readonly connection?: ConnInfo;
  /** Where `NNNN_name.sql` + `.plan.json` live. Default `./migrations`. */
  readonly migrations?: string;
  /** Tier R (design/06 §3.8). Default `./sql`. K3 owns the pass; K1 only carries the path. */
  readonly repeatables?: string;
  /**
   * The managed schema set. It is the diff's scope, the fingerprint's scope, AND the
   * advisory lock key's scope (design/06 §5.2: "derived, not fixed"), so a runner that
   * disagrees with the generator about it computes a different fingerprint and refuses.
   * Default `["public"]`.
   */
  readonly schemas?: readonly string[];
  /** `--shadow <url|docker|temp-schema|none>`; consumed by K2a's ladder, carried here. */
  readonly shadow?: ShadowStrategy;
  /** Path(s) to the TypeScript schema module. Consumed by K2b's `generate`. */
  readonly schema?: string | readonly string[];
  /** design/06 §5.2 defaults, overridable per project. */
  readonly lockTimeout?: string;
  readonly statementTimeout?: string;
  readonly lockWaitMs?: number;
  readonly staleLockAfterMs?: number;
  /** Force the production tag on regardless of `PG_PRIME_ENV`. */
  readonly production?: boolean;
}

/**
 * Identity, typed. It exists so the config file gets completion and so a typo in a key is
 * a compile error in the user's editor rather than a silently ignored setting.
 */
export function defineConfig(config: PgPrimeConfig): PgPrimeConfig {
  return config;
}

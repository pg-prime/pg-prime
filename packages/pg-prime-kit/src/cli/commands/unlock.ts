/**
 * `pg-prime migrate unlock [--force]` — design/06 §6.2, "inspect or break a stale lease".
 *
 * What it can and cannot do is worth being blunt about: it breaks the **lease row**, not
 * the session advisory lock. A session lock can only be released by the backend holding
 * it, and if that backend is alive the lease is not stale in the first place. So `unlock
 * --force` is for the case design/06 §5.2 names — a holder whose heartbeat stopped —
 * and it makes the *next* runner's report honest rather than forcing anything open.
 */

import type { ResolvedConfig } from "../../config/load.js";
import { withClient } from "../../db/pg.js";
import { forceUnlock, inspectLease } from "../../runner/run.js";
import { bool, ms, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { nowIso, pairs, type CommandOutput } from "../output.js";

export const UNLOCK_OPTIONS: readonly OptionSpec[] = [
  { name: "force", type: "boolean", describe: "delete the lease row" },
  { name: "stale-lock-after", type: "duration", placeholder: "duration", describe: "a lease whose heartbeat is older than this is stale", defaultText: "60s" },
];

export async function runUnlock(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const started = Date.now();
  const force = bool(argv.values, "force");
  const staleAfter = ms(argv.values, "stale-lock-after") ?? config.config.staleLockAfterMs;

  return withClient(config.connection, async (client) => {
    const before = await inspectLease(client, staleAfter);
    const released = force ? await forceUnlock(client) : false;

    const status = before.lease === null ? "no_lock" : released ? "released" : before.stale ? "stale" : "held";
    // A LIVE lease and no --force is the concurrent-deploy signal, and an orchestrator
    // that shells out to `unlock` to decide whether to retry needs it to be non-zero.
    const exitCode: ExitCode = status === "held" ? EXIT.locked : EXIT.ok;

    const durationMs = Date.now() - started;
    return {
      exitCode,
      envelope: {
        command: "migrate unlock",
        status,
        exitCode,
        at: nowIso(),
        durationMs,
        database: config.connection.database,
        forced: force,
        released,
        staleAfterMs: before.staleAfterMs,
        stale: before.stale,
        holder: before.lease,
        note:
          released && !before.stale
            ? "the lease was NOT stale — its holder's session lock, if the backend is still alive, is untouched"
            : null,
        error: null,
      },
      text:
        before.lease === null
          ? "migrate unlock\n\nno lease row: the migration lock is free."
          : [
              "migrate unlock",
              "",
              pairs([
                ["holder", before.lease.holder],
                ["run", before.lease.runId],
                ["acquired", before.lease.acquiredAt],
                ["heartbeat", `${before.lease.heartbeatAt} (${String(before.lease.heartbeatAgeMs)} ms ago)`],
                ["stale", before.stale ? `yes (> ${String(before.staleAfterMs)} ms)` : "no"],
                ["action", released ? "lease row deleted" : force ? "nothing to delete" : "none — pass --force to break it"],
              ]),
            ].join("\n"),
    };
  });
}

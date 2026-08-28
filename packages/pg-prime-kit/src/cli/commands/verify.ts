/**
 * `pg-prime migrate verify` — design/06 §6.2, "the differentiator no bundled migrator
 * ships".
 *
 * Provision an ephemeral database, **replay every migration from empty through the real
 * runner**, apply repeatables, extract the result, diff it against IR(desired), and assert
 * the diff is empty. That catches "the committed file does not do what the schema says",
 * which is a different failure from drift and which nothing else in this ecosystem checks.
 *
 * Three decisions worth stating:
 *
 *  - **It replays through `applyPending`, not `applySegments`.** The thing being verified
 *    is the repository as the runner will read it: the directives, the statement markers,
 *    the `txmode` dispatch, the fingerprint gate and the history bookkeeping are all part
 *    of "does this repo reproduce that schema", and a shortcut past them would verify a
 *    different program.
 *  - **It fails rather than skips** when there is no ephemeral database to be had
 *    (design/06 §10.2). A `verify` that quietly reports success because it could not run
 *    is worse than no `verify`.
 *  - **`--from-checkpoint` is refused**, with the sentence saying why: checkpoints are K4,
 *    and a flag that silently ignores its argument is how a bisect lies to you.
 */

import { extractCatalog } from "../../catalog/extract.js";
import { listCheckpoints } from "../../checkpoint/checkpoint.js";
import { ConfigError, loadSchema, type ResolvedConfig } from "../../config/load.js";
import { diffIR } from "../../diff/diff.js";
import { withClient } from "../../db/pg.js";
import { encodeId } from "../../ir/stable-id.js";
import { createRepeatablesPass, loadRepeatables } from "../../repeatables/index.js";
import { applyPending } from "../../runner/run.js";
import { loadDesired } from "../../schema/load.js";
import type { SchemaLike } from "../../schema/types.js";
import { provisionShadow, type Shadow, type ShadowStrategy } from "../../shadow/ladder.js";
import { bool, str, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bullets, nowIso, pairs, plural, type CommandOutput } from "../output.js";

export const VERIFY_OPTIONS: readonly OptionSpec[] = [
  { name: "to", type: "string", placeholder: "id", describe: "replay only up to this migration (bisecting)" },
  { name: "shadow", type: "string", placeholder: "url", describe: "the ephemeral database to replay into", defaultText: "CREATE DATABASE" },
  {
    name: "from-checkpoint",
    type: "boolean",
    describe: "replay from the newest checkpoint instead of from empty (design/06 §4.5)",
  },
  { name: "keep", type: "boolean", describe: "leave the ephemeral database behind for inspection" },
  {
    name: "against",
    type: "string",
    placeholder: "schema|target",
    describe: "what the replay is compared to: the TypeScript schema, or the live target database",
    defaultText: "schema, or target when the config names no schema",
  },
];

export async function runVerify(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const started = Date.now();
  const fail = (code: ExitCode, status: string, message: string, extra: Readonly<Record<string, unknown>> = {}): CommandOutput => ({
    exitCode: code,
    envelope: {
      command: "migrate verify",
      status,
      exitCode: code,
      at: nowIso(),
      durationMs: Date.now() - started,
      database: config.connection.database,
      migrationsDir: config.migrationsDir,
      schemas: config.schemas,
      replay: null,
      deltas: [],
      ...extra,
      error: { code: status, message },
    },
    text: `migrate verify\n\n${status.toUpperCase()}: ${message}`,
  });

  /**
   * design/06 §6.2: "replay every migration from empty (**or from the newest checkpoint
   * with `--from-checkpoint`**)".
   *
   * The runner's own §4.5 rule would do the jump by itself — `verify` always replays into
   * a *fresh* ephemeral database, which is precisely the condition for it. That is why the
   * default here is `checkpoints: "ignore"`: without it every `verify` in a repository
   * that has ever taken a checkpoint would silently become a partial replay reported as a
   * full one, which is the failure the old refusal existed to prevent. The flag turns the
   * jump back on, and the envelope says which question was asked.
   */
  const fromCheckpoint = bool(argv.values, "from-checkpoint");
  if (fromCheckpoint) {
    const available = await listCheckpoints(config.migrationsDir);
    if (available.length === 0) {
      return fail(
        EXIT.error,
        "refused",
        `--from-checkpoint was asked for and there is no NNNN_checkpoint.sql in ${config.migrationsDir}. ` +
          "Run `pg-prime migrate checkpoint` first, or drop the flag to replay from empty; a flag that " +
          "silently did nothing would report a full replay as a checkpoint one.",
      );
    }
  }
  /**
   * What is the replay compared to?
   *
   * `schema` — IR(desired), built from the TypeScript. That is the design's question:
   * "the committed file does not do what the schema says".
   *
   * `target` — the live database. That is the *adoption* question, and it is the only one
   * available to a repository that has no TypeScript schema yet — a `baseline`d database
   * whose migrations are pure SQL. design/11 §1.9's claim ("a baselined database is
   * reproducible from the repo") is exactly this comparison, and it is what the
   * third-party corpus gate runs. Defaulted rather than required: a config with no
   * `schema` has only one possible answer.
   */
  const againstRaw = str(argv.values, "against") ?? (config.schemaPaths.length === 0 ? "target" : "schema");
  if (againstRaw !== "schema" && againstRaw !== "target") {
    return fail(EXIT.error, "refused", `--against ${JSON.stringify(againstRaw)} is not one of schema, target`);
  }
  const against = againstRaw;
  if (against === "schema" && config.schemaPaths.length === 0) {
    return fail(
      EXIT.error,
      "refused",
      "pg-prime.config.ts names no `schema`: `verify` compares the replayed repository against " +
        "IR(desired), and IR(desired) comes from your TypeScript schema module(s). Pass " +
        "--against target to compare against the live database instead.",
    );
  }

  /* design/06 §10.2 — an ephemeral database, or a failure. Never a skip. */
  const url = str(argv.values, "shadow");
  const strategy: ShadowStrategy = url === undefined ? "createdb" : { url };
  let replayShadow: Shadow;
  try {
    replayShadow = await provisionShadow(config.connection, config.connection, {
      shadow: strategy,
      schemas: config.schemas,
    });
  } catch (err) {
    return fail(
      EXIT.error,
      "unavailable",
      `verify needs an ephemeral database and could not get one: ${err instanceof Error ? err.message : String(err)}. ` +
        "Grant the role CREATEDB, or pass --shadow postgres://…/a_throwaway_database. design/06 §10.2: " +
        "verify fails rather than skipping when neither is available.",
    );
  }
  if (replayShadow.tier === 3) {
    await replayShadow.dispose().catch(() => undefined);
    return fail(
      EXIT.error,
      "unavailable",
      "verify cannot replay into a temp schema: the migrations name their own schemas and would " +
        "collide with the live ones. Grant the role CREATEDB, or pass --shadow postgres://…/throwaway.",
    );
  }

  try {
    /* 1. replay the repository from empty, through the runner. */
    const replay = await applyPending(replayShadow.conn, config.migrationsDir, {
      schemas: config.schemas,
      repeatables: createRepeatablesPass(),
      repeatablesDir: config.repeatablesDir,
      appliedFrom: "migrate-verify",
      checkpoints: fromCheckpoint ? "auto" : "ignore",
      ...(str(argv.values, "to") === undefined ? {} : { to: str(argv.values, "to")! }),
    });
    if (replay.status !== "applied" && replay.status !== "up_to_date") {
      return fail(EXIT.error, "replay_failed", replay.error?.message ?? `replay reported ${replay.status}`, {
        replay: { status: replay.status, applied: replay.applied.map((a) => a.id) },
      });
    }

    /* 2. IR of the replayed database. */
    const replayed = await withClient(replayShadow.conn, (c) =>
      extractCatalog(c, { schemas: config.schemas, observe: false }),
    );

    /* 3. The reference IR. */
    let desiredFingerprint: string;
    let deltas: string[];
    if (against === "target") {
      const live = await withClient(config.connection, (c) =>
        extractCatalog(c, { schemas: config.schemas, observe: false }),
      );
      desiredFingerprint = live.ir.fingerprint;
      deltas = diffIR(replayed.ir, live.ir).deltas.map((d) => `${d.op} ${encodeId(d.op === "rename" ? d.to : d.id)}`);
    } else {
      /* IR(desired) — normalised in temp schemas INSIDE the ephemeral database, so this
       * command needs exactly one database however restricted the role is. */
      const schema = (await loadSchema(config.schemaPaths, process.cwd())).schema as SchemaLike;
      const desiredShadow = await provisionShadow(replayShadow.conn, replayShadow.conn, {
        shadow: "temp-schema",
        schemas: config.schemas,
      });
      try {
        const desired = await loadDesired(
          schema,
          desiredShadow,
          config.repeatablesDir === undefined
            ? {}
            : {
                afterLoad: async (client): Promise<void> => {
                  await loadRepeatables(client, config.repeatablesDir);
                },
              },
        );
        desiredFingerprint = desired.ir.fingerprint;
        const diff = diffIR(replayed.ir, desired.ir);
        deltas = diff.deltas.map((d) => `${d.op} ${encodeId(d.op === "rename" ? d.to : d.id)}`);
      } finally {
        await desiredShadow.dispose().catch(() => undefined);
      }
    }

    const partial = str(argv.values, "to") !== undefined;
    const empty = deltas.length === 0;
    // A `--to` replay is a BISECT, not a claim of convergence: it stops early on purpose,
    // so its diff is expected to be non-empty and exiting 4 on it would make the flag
    // useless. The deltas are printed either way; only the code differs, and the envelope
    // says which question was asked. (Divergence from §6.2, recorded in the AS BUILT note.)
    const exitCode: ExitCode = empty || partial ? EXIT.ok : EXIT.drift;
    const status = partial ? "replayed" : empty ? "verified" : "drift";

    return {
      exitCode,
      envelope: {
        command: "migrate verify",
        status,
        exitCode,
        at: nowIso(),
        durationMs: Date.now() - started,
        database: config.connection.database,
        migrationsDir: config.migrationsDir,
        schemas: config.schemas,
        ephemeral: { tier: replayShadow.tier, database: replayShadow.conn.database, kept: bool(argv.values, "keep") },
        against,
        fromCheckpoint,
        replay: {
          status: replay.status,
          applied: replay.applied.map((a) => a.id),
          repeatables: replay.repeatables.applied,
        },
        fingerprint: { replayed: replayed.ir.fingerprint, desired: desiredFingerprint },
        deltas,
        error: null,
      },
      text: [
        `migrate verify — replayed ${plural(replay.applied.length, "migration")} into ${replayShadow.conn.database}`,
        "",
        pairs([
          ["replayed", replayed.ir.fingerprint],
          ["desired", desiredFingerprint],
          ["verdict", status],
        ]),
        bullets("deltas:", deltas.slice(0, 40)),
      ]
        .filter((l) => l !== "")
        .join("\n"),
    };
  } catch (err) {
    if (err instanceof ConfigError) return fail(EXIT.error, "refused", err.message);
    return fail(EXIT.error, "error", err instanceof Error ? err.message : String(err));
  } finally {
    if (!bool(argv.values, "keep")) await replayShadow.dispose().catch(() => undefined);
  }
}

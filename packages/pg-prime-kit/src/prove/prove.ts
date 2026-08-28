import { randomBytes } from "node:crypto";
import pg from "pg";
import { extractCatalog } from "../catalog/extract.js";
import { buildStatements } from "../diff/ddl.js";
import { diffIR } from "../diff/diff.js";
import { orderStatements, type Segment } from "../diff/order.js";
import {
  createDatabase,
  dropDatabase,
  isObjectInUse,
  isShadowDatabase,
  withClient,
  withDatabase,
  SHADOW_PREFIX,
  type ConnInfo,
} from "../db/pg.js";
import { encodeId } from "../ir/stable-id.js";
import { SchemaIR } from "../ir/fact.js";
import type { PlanStatement, Proof } from "../plan/plan.js";
import { applySegments } from "../runner/apply.js";
import {
  compareDumps,
  dumpSchema,
  resolvePgDump,
  DUMP_SAMPLE_CAP,
  DUMP_TIMEOUT_MS,
  SpawnFailure,
  type DumpOracleMode,
  type DumpOracleVerdict,
  type PgDumpLauncher,
} from "./pg-dump.js";

/** One emitted file's worth of a plan. */
export interface ProveStage {
  readonly statements: readonly PlanStatement[];
  readonly segments: readonly Segment[];
}

export interface ProveInput {
  /** a maintenance connection (any database other than the one being cloned) */
  readonly admin: ConnInfo;
  /** the CURRENT-state database; cloned, never touched */
  readonly source: ConnInfo;
  readonly desired: SchemaIR;
  readonly schemas: readonly string[];
  readonly statements: readonly PlanStatement[];
  readonly segments: readonly Segment[];
  /**
   * The plan as the FILES it will be written to (design/06 §3.5 rows 1/6/7, §4.1).
   *
   * `generate` can emit `NNNN_name.sql` + `NNNN_name_concurrently.sql`; those apply in
   * that order and each has its own `from`/`to`, so the proof has to apply them in that
   * order too and report the fingerprint *between* them — that intermediate value is the
   * second file's `from`, and there is nowhere else to get it. Absent, the proof runs the
   * single stage `{ statements, segments }` and `stageFingerprints` has one entry.
   */
  readonly stages?: readonly ProveStage[];
  /**
   * The CURRENT-state IR, reused to materialise the shadow when a `TEMPLATE`
   * clone is not available. Re-extracted from `source` when absent.
   */
  readonly current?: SchemaIR;
  /** must start with `pgprime_shadow_`; anything else is refused (see `UnsafeCloneNameError`) */
  readonly cloneName?: string;
  readonly keepClone?: boolean;
  /**
   * Connection to the DESIRED database. Required by the pg_dump oracle, which compares
   * two live databases rather than two IRs; without it the oracle reports `skipped`,
   * which under `strict` blocks the plan unless `allowSkippedOracle` is set.
   */
  readonly desiredConn?: ConnInfo;
  /** default `"warn"` */
  readonly dumpOracle?: DumpOracleMode;
  /** under `strict`, let a `skipped` oracle through instead of blocking the plan */
  readonly allowSkippedOracle?: boolean;
  readonly pgDump?: PgDumpLauncher;
  /** how long a single `pg_dump` may run before it is killed */
  readonly dumpTimeoutMs?: number;
}

export class UnsafeCloneNameError extends Error {
  readonly code = "PG_PRIME_UNSAFE_CLONE_NAME";
  constructor(
    readonly cloneName: string,
    reason: string,
  ) {
    super(`refusing to use ${JSON.stringify(cloneName)} as a shadow clone: ${reason}`);
    this.name = "UnsafeCloneNameError";
  }
}

export interface ProofResult extends Proof {
  readonly cloneName: string;
}

/**
 * The clone is created, dropped `WITH (FORCE)` and re-created, so a caller-supplied
 * name is a loaded gun: `cloneName === source.database` destroyed the source.
 * Only names this tool would itself mint are accepted.
 */
function assertCloneName(name: string, input: ProveInput): void {
  if (!isShadowDatabase(name)) {
    throw new UnsafeCloneNameError(name, `it does not start with ${JSON.stringify(SHADOW_PREFIX)}`);
  }
  const reserved: [string, string | undefined][] = [
    ["source", input.source.database],
    ["desired", input.desiredConn?.database],
    ["admin", input.admin.database],
  ];
  for (const [role, db] of reserved) {
    if (db === name) throw new UnsafeCloneNameError(name, `it is the ${role} database`);
  }
}

/** Which tier of design/06 §3.2 actually provisioned the clone. */
export type ShadowProvisioning = "template" | "materialized";

/**
 * Provision an empty-or-cloned shadow WITHOUT ever disconnecting anybody.
 *
 * `TEMPLATE` is the cheapest exact copy, but PostgreSQL raises 55006 while any
 * session is attached to the template. The old code "fixed" that by terminating
 * those sessions — on the LIVE migration target. 55006 now simply demotes us to
 * the materialised tier, which needs no exclusive access at all.
 */
async function provisionShadow(input: ProveInput, clone: string): Promise<ShadowProvisioning> {
  const admin = new pg.Client({ ...input.admin });
  await admin.connect();
  try {
    await dropDatabase(admin, clone);
    try {
      await createDatabase(admin, clone, input.source.database);
      return "template";
    } catch (err) {
      if (!isObjectInUse(err)) throw err;
    }
    await createDatabase(admin, clone);
    return "materialized";
  } finally {
    await admin.end();
  }
}

/** Replay the CURRENT state into an empty shadow, from the IR we already hold. */
async function materializeCurrent(input: ProveInput, cloneConn: ConnInfo): Promise<void> {
  const current =
    input.current ?? (await withClient(input.source, (c) => extractCatalog(c, { schemas: input.schemas }))).ir;
  const bootstrap = diffIR(SchemaIR.build([], []), current);
  const ordered = orderStatements(buildStatements(bootstrap, current).statements);
  const statements: PlanStatement[] = ordered.statements.map((s, index) => ({
    ...s,
    index,
    timeouts: { lock: null, statement: null },
  }));
  const report = await withClient(cloneConn, (client) => applySegments(client, statements, ordered.segments));
  if (report.status === "failed") {
    throw new Error(
      `shadow materialisation failed at statement ${report.error?.statementIndex}: ` +
        `${report.error?.message} — ${report.error?.sql}`,
    );
  }
}

/**
 * `migrate verify` semantics, run at generate time (D6):
 * clone → apply the plan → re-extract → assert the diff against the desired
 * state is EMPTY. A plan that does not converge never reaches disk.
 */
export async function proveOnShadowClone(input: ProveInput): Promise<ProofResult> {
  const started = Date.now();
  const clone = input.cloneName ?? `${SHADOW_PREFIX}${randomBytes(4).toString("hex")}`;
  assertCloneName(clone, input);
  const provisioning = await provisionShadow(input, clone);

  const cloneConn = withDatabase(input.source, clone);
  const fail = async (proof: Proof): Promise<ProofResult> => {
    if (!input.keepClone) await cleanup(input.admin, clone);
    return { ...proof, provisioning, cloneName: clone, durationMs: Date.now() - started };
  };

  try {
    if (provisioning === "materialized") await materializeCurrent(input, cloneConn);
    const stages: readonly ProveStage[] = input.stages ?? [{ statements: input.statements, segments: input.segments }];
    const stageFingerprints: string[] = [];
    let after: Awaited<ReturnType<typeof extractCatalog>> | undefined;
    for (const [index, stage] of stages.entries()) {
      const applyReport = await withClient(cloneConn, (client) =>
        applySegments(client, stage.statements, stage.segments),
      );
      if (applyReport.status === "failed") {
        return await fail({
          status: "failed",
          at: new Date().toISOString(),
          shadow: "createdb",
          stageFingerprints,
          error:
            `${stages.length > 1 ? `file ${index + 1}/${stages.length}, ` : ""}` +
            `statement ${applyReport.error?.statementIndex}: ${applyReport.error?.message} — ${applyReport.error?.sql}`,
        });
      }
      // Extracted after EVERY stage, not only the last: the value after stage i is
      // stage i+1's `from.fingerprint`, and the runner refuses the file without it.
      after = await withClient(cloneConn, (client) => extractCatalog(client, { schemas: input.schemas }));
      stageFingerprints.push(after.ir.fingerprint);
    }
    if (after === undefined) {
      return await fail({
        status: "failed",
        at: new Date().toISOString(),
        shadow: "createdb",
        error: "proveOnShadowClone was given no statements to prove",
      });
    }
    const residual = diffIR(after.ir, input.desired);
    if (residual.deltas.length > 0) {
      return await fail({
        status: "failed",
        at: new Date().toISOString(),
        shadow: "createdb",
        driftDeltas: residual.deltas.length,
        deltas: residual.deltas.map((d) => `${d.op} ${encodeId(d.op === "rename" ? d.to : d.id)}`),
        stageFingerprints,
        error: "plan does not converge: non-empty diff after apply",
      });
    }
    // Fingerprint equality is the stronger statement: it covers edges too.
    //
    // Except where the differ deliberately refuses to converge. An adopted partition and
    // a retained extension are facts the clone keeps ON PURPOSE (design/05 §7.2, design/06
    // §2.2) — demanding fingerprint equality there would demand a DROP the design forbids,
    // and every plan touching a partitioned table would be refused. The delta check above
    // is still exact; only the whole-IR hash is waived, and only when the diff said why.
    const adopted = residual.diagnostics.filter(
      (d) => d.code === "adopted_partition" || d.code === "extension_retained",
    );
    if (adopted.length === 0 && after.ir.fingerprint !== input.desired.fingerprint) {
      return await fail({
        status: "failed",
        at: new Date().toISOString(),
        shadow: "createdb",
        driftDeltas: 0,
        stageFingerprints,
        error: `fingerprint mismatch after apply: ${after.ir.fingerprint} != ${input.desired.fingerprint}`,
      });
    }
    // The IR equality above can only see attributes our extractor models. Ask
    // PostgreSQL's own serializer whether anything ELSE differs (D6 amendment).
    const dumpOracle = await runDumpOracle(input, clone, after.pgVersionNum);
    // Under `strict`, an oracle that did not RUN is not evidence of success
    // either: silence is exactly what the witness exists to prevent. Opt out
    // with `allowSkippedOracle` when the environment genuinely has no pg_dump.
    const blockedByFailure = dumpOracle.mode === "strict" && dumpOracle.status === "failed";
    const blockedBySkip = dumpOracle.mode === "strict" && dumpOracle.status === "skipped" && !input.allowSkippedOracle;
    const blocked = blockedByFailure || blockedBySkip;
    return await fail({
      status: blocked ? "failed" : "passed",
      at: new Date().toISOString(),
      shadow: "createdb",
      driftDeltas: 0,
      stageFingerprints,
      dumpOracle,
      ...(blockedByFailure
        ? {
            error:
              `pg_dump oracle: ${dumpOracle.missingCount ?? 0} statement(s) missing from the ` +
              `migrated clone, ${dumpOracle.extraCount ?? 0} unexpected - the plan converges on ` +
              `our IR but not on PostgreSQL's own schema serialization`,
          }
        : {}),
      ...(blockedBySkip
        ? {
            error:
              `pg_dump oracle could not run under strict mode: ${dumpOracle.reason ?? "unknown reason"} ` +
              `(pass allowSkippedOracle to accept an unwitnessed plan)`,
          }
        : {}),
    });
  } catch (err) {
    return await fail({
      status: "failed",
      at: new Date().toISOString(),
      shadow: "createdb",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function cleanup(adminConn: ConnInfo, clone: string): Promise<void> {
  const admin = new pg.Client({ ...adminConn });
  await admin.connect();
  try {
    await dropDatabase(admin, clone);
  } finally {
    await admin.end();
  }
}

/**
 * Dump the migrated clone and the desired database and require them to be identical.
 *
 * Only an ENVIRONMENT gap is `skipped`: no launcher, a launcher that will not spawn or
 * report `--version`, or a pg_dump older than the server. A dump that ran and failed —
 * wrong schema pattern, permission denied, connection refused, timeout — is `failed`,
 * because those say something about this run and used to be silently swallowed.
 */
async function runDumpOracle(input: ProveInput, clone: string, serverVersionNum: number): Promise<DumpOracleVerdict> {
  const mode: DumpOracleMode = input.dumpOracle ?? "warn";
  if (mode === "off") return { status: "skipped", mode, reason: "disabled" };
  if (!input.desiredConn) {
    return { status: "skipped", mode, reason: "no desiredConn supplied" };
  }

  const pgDump = await resolvePgDump(input.pgDump);
  if ("unavailable" in pgDump) return { status: "skipped", mode, reason: pgDump.unavailable };

  // pg_dump refuses to dump a server newer than itself, and an equal-major-but-older
  // minor can still emit a different dialect. Older ⇒ environment gap, not a verdict.
  const serverMajor = Math.floor(serverVersionNum / 10000);
  if (serverMajor > 0 && pgDump.major < serverMajor) {
    return {
      status: "skipped",
      mode,
      pgDumpVersion: pgDump.version,
      reason: `pg_dump major ${pgDump.major} is older than the server (major ${serverMajor})`,
    };
  }

  const desiredConn = input.desiredConn;
  const timeoutMs = input.dumpTimeoutMs ?? DUMP_TIMEOUT_MS;
  try {
    const [cloneDump, desiredDump] = await bothDumps((signal) => [
      dumpSchema({ pgDump, conn: input.source, database: clone, schemas: input.schemas, timeoutMs, signal }),
      dumpSchema({
        pgDump,
        conn: desiredConn,
        database: desiredConn.database,
        schemas: input.schemas,
        timeoutMs,
        signal,
      }),
    ]);
    const cmp = compareDumps(cloneDump, desiredDump);
    const reordered = cmp.reordered.length > 0 ? { reordered: cmp.reordered } : {};
    if (cmp.equal) {
      return {
        status: "passed",
        mode,
        pgDumpVersion: pgDump.version,
        statementCount: cmp.statementCount,
        ...reordered,
      };
    }
    return {
      status: "failed",
      mode,
      pgDumpVersion: pgDump.version,
      statementCount: cmp.statementCount,
      missingCount: cmp.missing.length,
      extraCount: cmp.extra.length,
      missing: cmp.missing.slice(0, DUMP_SAMPLE_CAP),
      extra: cmp.extra.slice(0, DUMP_SAMPLE_CAP),
      ...reordered,
    };
  } catch (err) {
    // The launcher not starting is still an environment gap; everything else
    // (bad pattern, refused connection, timeout) is evidence about this run.
    if (err instanceof SpawnFailure) return { status: "skipped", mode, reason: err.message };
    return { status: "failed", mode, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run both dumps concurrently and never leave the sibling running when one fails —
 * a hung `pg_dump` on the desired database would otherwise outlive the whole proof.
 */
async function bothDumps(
  make: (signal: AbortSignal) => readonly [Promise<string>, Promise<string>],
): Promise<[string, string]> {
  const controller = new AbortController();
  const [a, b] = make(controller.signal);
  const guard = (p: Promise<string>): Promise<string> =>
    p.catch((err: unknown) => {
      controller.abort();
      throw err;
    });
  const settled = await Promise.allSettled([guard(a), guard(b)]);
  const failure = settled.find((r) => r.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const [first, second] = settled as PromiseFulfilledResult<string>[];
  return [first!.value, second!.value];
}

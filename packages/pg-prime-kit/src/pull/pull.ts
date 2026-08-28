/**
 * `pg-prime pull` — design/06 §6.2's twelfth command, design/12 decision 15.
 *
 * ```
 *   target DB ──extract──► IR ──► a deterministic TypeScript schema file
 *                  │
 *                  └──catalog (Tier R)──► sql/ repeatables
 *                                    residue ──► `-- pull: unsupported` + pull.report.json
 * ```
 *
 * The command reads and writes files; it never touches the database beyond one
 * `REPEATABLE READ READ ONLY` extraction and a handful of Tier-R catalog queries.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { extractCatalog, type Diagnostic } from "../catalog/extract.js";
import { withClient, type ConnInfo } from "../db/pg.js";
import { observedCounts } from "../catalog/extract.js";
import { emitTypeScript, type UnsupportedItem } from "./emit-ts.js";
import { readTierR, type TierRObject } from "./tier-r.js";

export interface PullInput {
  readonly connection: ConnInfo;
  readonly schemas: readonly string[];
  /** where the `.ts` goes; the report goes beside it as `pull.report.json` */
  readonly out: string;
  /** where Tier-R repeatables go. Absent ⟹ they are counted as residue instead. */
  readonly sqlDir?: string;
}

export interface PullResult {
  readonly ts: string;
  readonly repeatables: readonly TierRObject[];
  readonly unsupported: readonly UnsupportedItem[];
  readonly counts: Readonly<Record<string, number>>;
  readonly observed: readonly { readonly kind: string; readonly count: number }[];
  readonly diagnostics: readonly Diagnostic[];
  readonly fingerprint: string;
}

/** Read the database and produce everything, writing nothing. */
export async function pullSchema(input: PullInput): Promise<PullResult> {
  const schemas = [...new Set(input.schemas)].sort();
  return withClient(input.connection, async (client) => {
    const extracted = await extractCatalog(client, { schemas, observe: true });
    const prefix = input.sqlDir === undefined ? "sql" : posixBase(input.sqlDir);
    const tierR = await readTierR(client, schemas, prefix);

    // A Tier-R object with nowhere to go is residue, not a silent loss.
    const orphanTierR: UnsupportedItem[] =
      input.sqlDir === undefined
        ? tierR.objects.map((o) => ({
            kind: o.kind,
            name: o.identity,
            reason: "--sql-dir was not given, so there is nowhere to write the Tier-R repeatable",
          }))
        : [];

    const emitted = emitTypeScript(extracted.ir, {
      schemas,
      sqlDir: prefix,
      repeatableCount: input.sqlDir === undefined ? 0 : tierR.objects.length,
      extraUnsupported: [...tierR.unsupported, ...orphanTierR],
    });

    return {
      ts: emitted.ts,
      repeatables: input.sqlDir === undefined ? [] : tierR.objects,
      unsupported: emitted.unsupported,
      counts: emitted.counts,
      observed: observedCounts(extracted.observed),
      diagnostics: extracted.diagnostics,
      fingerprint: extracted.ir.fingerprint,
    };
  });
}

export interface WrittenPull {
  readonly out: string;
  readonly report: string;
  readonly repeatables: readonly string[];
}

/**
 * Write the `.ts`, the `sql/` tree and `pull.report.json`.
 *
 * Overwriting is deliberate and is the difference between this and `writePlan`: a
 * migration is immutable history, and a pulled schema is a snapshot you re-take. The
 * round-trip property ("a second `pull` over the result is byte-identical") is only
 * checkable if the second one is allowed to write.
 */
export async function writePull(input: PullInput, result: PullResult): Promise<WrittenPull> {
  const out = resolve(input.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, result.ts, "utf8");

  const written: string[] = [];
  if (input.sqlDir !== undefined) {
    const root = resolve(input.sqlDir);
    for (const object of result.repeatables) {
      // `path` carries the sql dir's own name as its first segment (like a repeatable's
      // `pgprime.repeatables` key), so it is stripped before joining or the tree nests.
      const relPath = object.path.split("/").slice(1).join(sep);
      const target = join(root, relPath);
      if (!target.startsWith(root + sep)) throw new Error(`refusing to write ${target}: outside ${root}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${object.sql.trimEnd()}\n`, "utf8");
      written.push(target);
    }
  }

  const report = join(dirname(out), "pull.report.json");
  await writeFile(report, `${JSON.stringify(reportOf(input, result, out), null, 2)}\n`, "utf8");
  return { out, report, repeatables: written };
}

function reportOf(input: PullInput, result: PullResult, out: string): unknown {
  return {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    database: input.connection.database,
    schemas: [...input.schemas].sort(),
    fingerprint: result.fingerprint,
    out: relative(dirname(out), out),
    counts: result.counts,
    repeatables: result.repeatables.map((r) => ({ kind: r.kind, identity: r.identity, path: r.path })),
    unsupported: [...result.unsupported].sort((a, b) => (`${a.kind} ${a.name}` < `${b.kind} ${b.name}` ? -1 : 1)),
    observed: result.observed,
    diagnostics: result.diagnostics
      .filter((d) => d.severity !== "info")
      .map((d) => ({ code: d.code, severity: d.severity, subject: d.subject ?? null, message: d.message })),
  };
}

const posixBase = (path: string): string => {
  const parts = resolve(path)
    .split(sep)
    .filter((p) => p !== "");
  return parts[parts.length - 1] ?? "sql";
};

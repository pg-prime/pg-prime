/**
 * R17's "documented list", and the fixture the CLI goldens run against.
 *
 * The rule the design states is that volatile fields are masked **by name**, never by a
 * regex over the whole document: a regex that rewrites anything resembling a timestamp
 * also rewrites a migration id that happens to contain digits, and then a golden stops
 * being evidence. Every entry below is here because it is non-deterministic across runs
 * or across machines, with the reason beside it.
 */

export const MASKED: readonly string[] = [
  "at",                       // wall clock
  "durationMs",               // wall clock
  "database",                 // the scratch database's name is per-run
  "migrationsDir",            // an absolute path under os.tmpdir()
  "fingerprint",              // depends on the server version and on the fixture's oids
  "lock.runId",               // a uuid
  "lock.waitedMs",            // wall clock
  "lock.holder",              // hostname:pid
  "holder",                   // hostname:pid (migrate unlock)
  "applied[].durationMs",     // wall clock
  "migrations[].appliedAt",   // wall clock
  "migrations[].appliedBy",   // the connecting role
  "written.sql",              // an absolute path
  "written.plan",             // an absolute path
  "migration.planId",         // a hash over server-dependent payloads
  "migration.fingerprint",
  "migration.proof.at",
  "error.message",            // embeds paths and fingerprints; asserted with toContain instead
];

export const MASK = "<masked>";

/**
 * Replace every masked path with `MASK`. Arrays are addressed with `[]`, so
 * `applied[].durationMs` masks that field in every element and nothing else.
 */
export function mask(value: unknown, paths: readonly string[] = MASKED): unknown {
  const set = new Set(paths);
  const walk = (node: unknown, path: string): unknown => {
    if (set.has(path)) return MASK;
    if (Array.isArray(node)) return node.map((item) => walk(item, `${path}[]`));
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = walk(child, path === "" ? key : `${path}.${key}`);
      }
      return out;
    }
    return node;
  };
  return walk(value, "");
}

export const golden = (value: unknown): string => `${JSON.stringify(mask(value), null, 2)}\n`;

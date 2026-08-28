/**
 * `pg-prime migrate check` — design/06 §6.2, "the default CI gate".
 *
 * Three questions, one exit code:
 *
 *   a. would `generate` produce a non-empty diff? — "you forgot to run generate"
 *   b. do all checksums match, and is every recorded file still on disk?
 *   c. are there pending migrations?
 *
 * **No history writes.** It never calls `ensureHistory`, never takes the lock and never
 * records a row. It does provision a shadow, and on tier 3 that means a temp schema
 * created and dropped inside the target database — the one write the design's "no DB
 * writes" cannot avoid, because normalising the desired state is what the question is.
 * Pass `--shadow <url>` to keep even that out of the target.
 *
 * Precedence, when more than one answer is bad: **2** (a rename or a data-loss decision is
 * missing) beats **3** (an error-severity hazard) beats **4** (drift, either kind) beats
 * **5** (pending). The rule is "the answer a human has to act on first".
 */

import { ConfigError, loadSchema, type ResolvedConfig } from "../../config/load.js";
import { generate, GenerateRefusedError } from "../../generate.js";
import { isEmptyDiff } from "../../diff/diff.js";
import { createRepeatablesPass } from "../../repeatables/index.js";
import { readMigrationsDir } from "../../runner/files.js";
import { migrationStatus } from "../../runner/status.js";
import type { SchemaLike } from "../../schema/types.js";
import { OfflineShadowError } from "../../shadow/ladder.js";
import { bool, str, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bullets, nowIso, pairs, plural, type CommandOutput } from "../output.js";

export const CHECK_OPTIONS: readonly OptionSpec[] = [
  { name: "shadow", type: "string", placeholder: "url|temp-schema|createdb", describe: "how the desired state is normalized" },
  { name: "strict-unmodeled", type: "boolean", describe: "a non-empty Tier-U census becomes an error" },
  { name: "no-schema", type: "boolean", describe: "skip question (a); check only checksums and pending files" },
];

export async function runCheck(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const started = Date.now();

  /* (b) and (c) — files on disk against pgprime.migrations. Read-only. */
  const { files } = await readMigrationsDir(config.migrationsDir);
  const status = await migrationStatus(config.connection, config.migrationsDir, {
    schemas: config.schemas,
    repeatables: createRepeatablesPass(),
    repeatablesDir: config.repeatablesDir,
  });

  /* (a) — would generate produce anything? */
  let schemaDrift: readonly string[] | null = null;
  let unresolved: unknown[] = [];
  let hazards: { code: string; subject: string; message: string }[] = [];
  let generateError: string | null = null;
  const wantSchema = !bool(argv.values, "no-schema") && config.schemaPaths.length > 0;
  if (wantSchema) {
    try {
      const schema = (await loadSchema(config.schemaPaths, process.cwd())).schema as SchemaLike;
      const result = await generate({
        target: config.connection,
        schema,
        repeatablesDir: config.repeatablesDir,
        schemas: config.schemas,
        seq: 0,
        name: "check",
        // No file is written and nothing is applied, so the CONCURRENTLY split would only
        // cost a second proof stage; and the proof is not what `check` is asking about.
        multiFile: false,
        prove: false,
        ...(bool(argv.values, "strict-unmodeled") ? { strictUnmodeled: true } : {}),
        ...(() => {
          const raw = str(argv.values, "shadow");
          if (raw === undefined) return config.config.shadow === undefined ? {} : { shadow: config.config.shadow };
          if (raw.startsWith("postgres://") || raw.startsWith("postgresql://")) return { shadow: { url: raw } };
          if (raw === "temp-schema" || raw === "createdb" || raw === "auto") return { shadow: raw };
          throw new GenerateRefusedError(`--shadow ${JSON.stringify(raw)} is not a url, createdb or temp-schema`);
        })(),
      });
      /*
       * "Would `generate` produce a non-empty diff?" is not quite the question. After
       * `generate` and before `apply` the diff against the *database* is non-empty by
       * construction — that is what the pending file is for — and reporting it as
       * exit 4 ("you forgot to run generate") would make `check` unusable in exactly the
       * commit where a migration was added.
       *
       * The honest test is whether PENDING migrations account for the diff: the last
       * file's `to.fingerprint` is the state the repository claims to reach, so if there
       * is something to apply and that value is IR(desired)'s fingerprint, the schema is
       * not ahead of the migrations — they are simply not applied yet, which is exit 5.
       *
       * "Pending" is load-bearing. With everything applied, a non-empty diff means the
       * DATABASE moved (somebody changed it by hand) or the SCHEMA moved (somebody forgot
       * to generate), and both of those are exit 4.
       */
      const accountedFor =
        status.pending.length > 0 &&
        files.length > 0 &&
        files[files.length - 1]?.plan?.to.fingerprint === result.desiredIR.fingerprint;
      schemaDrift =
        isEmptyDiff(result.diff) || accountedFor
          ? []
          : result.files.flatMap((f) => f.plan?.statements.map((s) => s.sql) ?? []);
      unresolved = [...result.unresolved];
      hazards = result.files
        .flatMap((f) => f.plan?.hazards ?? [])
        .filter((h) => h.severity === "error" && !h.acknowledged)
        .map((h) => ({ code: h.code, subject: h.subject, message: h.message }));
    } catch (err) {
      if (err instanceof OfflineShadowError || err instanceof GenerateRefusedError || err instanceof ConfigError) {
        generateError = err.message;
      } else {
        throw err;
      }
    }
  }

  const drift = [...status.missingFiles, ...status.checksumDrift];
  const exitCode: ExitCode =
    generateError !== null
      ? EXIT.error
      : unresolved.length > 0
        ? EXIT.missingHints
        : hazards.length > 0
          ? EXIT.lint
          : drift.length > 0 || (schemaDrift !== null && schemaDrift.length > 0)
            ? EXIT.drift
            : status.pending.length > 0
              ? EXIT.pending
              : EXIT.ok;

  const label =
    exitCode === EXIT.ok
      ? "ok"
      : exitCode === EXIT.error
        ? "error"
        : exitCode === EXIT.missingHints
          ? "missing_hints"
          : exitCode === EXIT.lint
            ? "lint"
            : exitCode === EXIT.drift
              ? "drift"
              : "pending";

  return {
    exitCode,
    envelope: {
      command: "migrate check",
      status: label,
      exitCode,
      at: nowIso(),
      durationMs: Date.now() - started,
      database: config.connection.database,
      migrationsDir: config.migrationsDir,
      schemas: config.schemas,
      schemaChecked: wantSchema,
      schemaDrift,
      checksumDrift: status.checksumDrift,
      missingFiles: status.missingFiles,
      pending: status.pending,
      repeatableDrift: status.repeatables.drift,
      unresolved,
      hazards,
      error: generateError === null ? null : { code: "generate_failed", message: generateError },
    },
    text: [
      `migrate check — ${config.connection.database}`,
      "",
      pairs([
        ["schema", !wantSchema ? "not checked" : schemaDrift === null ? "could not be checked" : schemaDrift.length === 0 ? "matches" : `${plural(schemaDrift.length, "statement")} would be generated`],
        ["checksums", drift.length === 0 ? "ok" : `${plural(drift.length, "file")} drifted`],
        ["pending", status.pending.length === 0 ? "none" : plural(status.pending.length, "migration")],
      ]),
      bullets("would generate:", (schemaDrift ?? []).slice(0, 20)),
      bullets("checksum drift:", drift),
      bullets("pending:", status.pending),
      bullets("unacknowledged hazards:", hazards.map((h) => `${h.code} ${h.subject}`)),
      generateError === null ? "" : `\nERROR: ${generateError}`,
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}

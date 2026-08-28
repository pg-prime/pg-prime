/**
 * pg-prime-kit — the in-house diff engine spike (design/06, sign-off item 7).
 *
 *   pg_catalog ──extract──► fact base (IR) ──diff──► Delta[] ──emit──► Statement[]
 *                                                       │
 *                                             order (topological + `evaluates`)
 *                                                       ▼
 *                                     prove on a shadow clone ──► NNNN_name.sql + .plan.json
 */

export { canonicalize, contentHash, sha256, type Hash, type Payload } from "./ir/hash.js";
export {
  encodeId,
  parseId,
  idName,
  idSchema,
  parentOf,
  commentId,
  defaultId,
  sameId,
  type FactKind,
  type StableId,
} from "./ir/stable-id.js";
export {
  SchemaIR,
  CATALOG_PROVENANCE,
  type DependencyEdge,
  type EdgeKind,
  type Fact,
  type Origin,
  type Ownership,
  type Provenance,
} from "./ir/fact.js";

export {
  extractCatalog,
  evaluatedEnumLabels,
  observationDiagnostics,
  observedCounts,
  probeEmptiness,
  type CatalogClient,
  type Diagnostic,
  type ExtractOptions,
  type ExtractResult,
} from "./catalog/extract.js";
export type * from "./catalog/payloads.js";

export { diffIR, isEmptyDiff, labelsOf, type DiffOptions, type DiffResult } from "./diff/diff.js";
export { applyRenameHints, definitionsAgreeUnderRename, tokenizeDefinition } from "./diff/rename.js";
export type { Delta, RenameHint, RenameRecord } from "./diff/delta.js";
export {
  buildStatements,
  columnClause,
  mentionsVolatileFunction,
  type BuildOptions,
  type BuildResult,
} from "./diff/ddl.js";
export { orderStatements, type OrderResult, type Segment } from "./diff/order.js";
export { PHASE, type LockClass, type Statement, type Transactionality } from "./diff/statement.js";

export {
  buildPlan,
  hazardSeverity,
  migrationId,
  renderSql,
  ENGINE,
  InvalidMigrationIdError,
  MIGRATION_NAME,
  type Acknowledgement,
  type AcknowledgeInput,
  type Plan,
  type PlanHazard,
  type PlanStatement,
  type Proof,
} from "./plan/plan.js";
export {
  writePlan,
  planSql,
  ProofRequiredError,
  UnacknowledgedHazardError,
  UnsafePlanPathError,
  WriteRefusedError,
} from "./plan/emit.js";

export {
  proveOnShadowClone,
  UnsafeCloneNameError,
  type ProofResult,
  type ProveInput,
  type ShadowProvisioning,
} from "./prove/prove.js";
export {
  compareDumps,
  dumpSchema,
  normalizeDump,
  parseLauncherEnv,
  resolvePgDump,
  schemaPattern,
  SpawnFailure,
  DUMP_SAMPLE_CAP,
  DUMP_TIMEOUT_MS,
  type DumpComparison,
  type DumpOracleMode,
  type DumpOracleVerdict,
  type DumpRequest,
  type PgDumpLauncher,
  type ResolvedPgDump,
} from "./prove/pg-dump.js";
export {
  applySegments,
  advisoryLockKey,
  acquireSessionLock,
  releaseSessionLock,
  detectTransactionPooler,
  type ApplyReport,
} from "./runner/apply.js";

export { generate, type GenerateInput, type GenerateResult } from "./generate.js";

/**
 * The DSL → desired-state leg (design/11 §3 K2a). `pg-prime` is a PEER dependency and is imported
 * for TYPES ONLY — `test/schema-emit/no-value-import.test.ts` fails the build on a value import.
 */
export { emitSchema, EmitError, type EmitOptions, type EmitResult } from "./schema/emit.js";
export { desiredSql, loadDesired, DesiredLoadError, type LoadDesiredOptions } from "./schema/load.js";
export { makeRemapper, remapDiagnostics, remapIr, type Remapper } from "./schema/remap.js";
export type { ColumnDdl, RefRuntime, SchemaLike, TableExtra, TableLike, TableRuntime } from "./schema/types.js";
export {
  parseShadowUrl,
  provisionShadow,
  OfflineShadowError,
  ShadowNameTooLongError,
  type ProvisionShadowOptions,
  type Shadow,
  type ShadowStrategy,
} from "./shadow/ladder.js";

export {
  connectionString,
  createDatabase,
  dropDatabase,
  isObjectInUse,
  isShadowDatabase,
  runSqlScript,
  terminateConnections,
  withClient,
  withDatabase,
  SHADOW_PREFIX,
  SQLSTATE_OBJECT_IN_USE,
  UnsafeDatabaseNameError,
  type ConnInfo,
} from "./db/pg.js";

export {
  chooseConstraintName,
  defaultNotNullName,
  makeObjectName,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
  isValidIdent,
  hasLoneSurrogate,
  hasNul,
  utf8ByteLength,
  InvalidIdentifierError,
  MAX_IDENT_BYTES,
  type IdentifierProblem,
} from "./sql/ident.js";
export {
  canonicalize as canonicalizeSql,
  codeMask,
  dollarTagAt,
  lexSql,
  splitStatements,
  type Segment as SqlSegment,
} from "./sql/statements.js";

/* ---- Tier R: repeatables (design/06 §3.8, §5.1 step 8) ---- */
export {
  applyRepeatables,
  checkIdempotence,
  createRepeatablesPass,
  loadRepeatables,
  parseDirectives,
  planRepeatables,
  RepeatableApplyError,
  scanRepeatables,
  type AppliedRepeatable,
  type Directive,
  type IdempotenceResult,
  type IdempotenceViolation,
  type RepeatableClient,
  type RepeatableFile,
  type RepeatablesPass,
  type RepeatablesPlan,
  type ScanOptions,
} from "./repeatables/index.js";

/* ---- `migrate lint`, as a pure function (design/06 §3.4, §6.2) ---- */
export {
  formatFindings,
  lintPlan,
  parseNolint,
  unusedDirectives,
  type DirectiveError,
  type LintFinding,
  type LintFormat,
  type LintOptions,
  type LintResult,
  type NolintDirective,
} from "./lint/lint.js";
export { planRules, isStyleCode, STYLE_CODES, type RuleHit } from "./lint/rules.js";

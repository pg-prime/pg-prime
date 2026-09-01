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
  type ApplyError,
  type ApplyOptions,
  type ApplyReport,
} from "./runner/apply.js";

/* ------------------------- the runner (design/06 §5) ------------------------ */

export {
  applyPending,
  applyPendingOn,
  forceUnlock,
  inspectLease,
  NO_REPEATABLES,
  PoolRefusedError,
  type AppliedMigration,
  type ApplyPendingOptions,
  type ApplyPendingResult,
  type IssuedQuery,
  type LeaseInspection,
  type LockReport,
  type PreflightReport,
  type RepeatablesReport,
  type RunnerEvent,
  type RunnerFailure,
} from "./runner/run.js";
export {
  executionPlan,
  findDirectives,
  parseMigrationSql,
  readMigrationsDir,
  BATCH_DEFAULTS,
  MIGRATION_FILE,
  type BatchDirective,
  type ExecutionPlan,
  type FileDirective,
  type FileDirectives,
  type FileStatement,
  type MigrationFile,
  type ParsedSql,
  type ReadMigrationsResult,
  type TxMode,
} from "./runner/files.js";
export {
  migrationStatus,
  migrationStatusOn,
  type DataProgressEntry,
  type EntryState,
  type StatusEntry,
  type StatusOptions,
  type StatusReport,
} from "./runner/status.js";

/* ---- design/06 §7 lane 2: batched, resumable, lag-aware data migrations ---- */
export {
  runBatchStatement,
  BatchStalledError,
  GUC_BATCH_SIZE,
  GUC_WATERMARK,
  STALL_LIMIT,
  type BatchEvent,
  type BatchOptions,
  type BatchOutcome,
  type LagEvent,
} from "./data/batch.js";
export { readPrimaryLag, readReplicaLag, type LagReading } from "./data/lag.js";

/* --------------------- history tables (design/06 §4.4) --------------------- */

export {
  ensureHistory,
  historyPresent,
  historyVersion,
  HISTORY_DDL,
  HISTORY_SCHEMA,
  HISTORY_VERSION,
  type MigrationStatus,
} from "./history/schema.js";
export {
  currentFingerprint,
  dataProgressSql,
  readAllDataProgress,
  readDataProgress,
  readMigrationRows,
  readRepeatableRows,
  EMPTY_WATERMARK,
  type DataProgress,
  type LockRow,
  type MigrationRow,
  type RepeatableRow,
} from "./history/store.js";

/* ---------------------- the CLI's contracts (design/06 §6) ------------------ */

export { EXIT, RUNNER_EXIT, type ExitCode, type RunnerStatus } from "./cli/exit.js";
export {
  defineConfig,
  findConfigFile,
  loadConfig,
  loadSchema,
  parseDatabaseUrl,
  resolveConfig,
  ConfigError,
  CONFIG_FILENAMES,
  ENV_VAR,
  STRIP_TYPES_MARKER,
  type LoadedConfig,
  type LoadedSchema,
  type ParsedUrl,
  type PgPrimeConfig,
  type ResolveInput,
  type ResolvedConfig,
} from "./config/index.js";

export {
  annotationHints,
  acceptHints,
  dataMigrationSql,
  emptyMigrationSql,
  generate,
  generateFromDatabases,
  nonConcurrentIndexes,
  readHintsFile,
  slug,
  GenerateRefusedError,
  type DatabaseGenerateInput,
  type DatabaseGenerateResult,
  type DataStubInput,
  type GeneratedFile,
  type GenerateInput,
  type GenerateResult,
  type GenerateStatus,
  type Unresolved,
} from "./generate.js";
export { renameCandidates, type RenameCandidate, type RenameConfidence } from "./diff/candidates.js";
export { splitStages, type StagedFile, type StagedResult } from "./diff/order.js";
export { planOrderKey } from "./plan/emit.js";
export { proveInTempSchemas, type TempSchemaProveInput } from "./prove/temp-schema.js";
export type { Stage } from "./diff/statement.js";
export type { ProveStage } from "./prove/prove.js";

/**
 * The DSL → desired-state leg (design/11 §3 K2a). `pg-prime` is a PEER dependency and is imported
 * for TYPES ONLY — `test/schema-emit/no-value-import.test.ts` fails the build on a value import.
 */
export { emitSchema, EmitError, type EmitOptions, type EmitResult } from "./schema/emit.js";
export { desiredSql, loadDesired, DesiredLoadError, type LoadDesiredOptions } from "./schema/load.js";
export { makeRemapper, remapDiagnostics, remapIr, remapObserved, type Remapper } from "./schema/remap.js";
export type {
  ColumnDdl,
  RefRuntime,
  SchemaLike,
  TableExtra,
  TableLike,
  TableRuntime,
  ViewInfo,
  ViewLike,
  ViewRuntime,
} from "./schema/types.js";
export {
  declaredViewIdentities,
  DECLARED_DIRECTIVE,
  renderViewRepeatables,
  syncViewRepeatables,
  VIEWS_DIR,
  type DeclaredView,
  type RenderedViews,
  type RenderViewsOptions,
  type SyncedViews,
  type SyncViewsOptions,
} from "./schema/views.js";
export {
  parseShadowUrl,
  provisionShadow,
  OfflineShadowError,
  ShadowNameTooLongError,
  ShadowStrategyError,
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

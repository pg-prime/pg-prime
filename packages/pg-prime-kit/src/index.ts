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
export { encodeId, parseId, idName, parentOf, type FactKind, type StableId } from "./ir/stable-id.js";
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

export { extractCatalog, evaluatedEnumLabels, type CatalogClient, type Diagnostic, type ExtractResult } from "./catalog/extract.js";
export type * from "./catalog/payloads.js";

export { diffIR, isEmptyDiff, labelsOf, type DiffOptions, type DiffResult } from "./diff/diff.js";
export { applyRenameHints, definitionsAgreeUnderRename, tokenizeDefinition } from "./diff/rename.js";
export type { Delta, RenameHint, RenameRecord } from "./diff/delta.js";
export { buildStatements, columnClause, type BuildResult } from "./diff/ddl.js";
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
export { canonicalize as canonicalizeSql, dollarTagAt, lexSql, splitStatements, type Segment as SqlSegment } from "./sql/statements.js";

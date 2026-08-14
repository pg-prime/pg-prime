/**
 * pgorm-kit — the in-house diff engine spike (design/06, sign-off item 7).
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
export { applyRenameHints } from "./diff/rename.js";
export type { Delta, RenameHint, RenameRecord } from "./diff/delta.js";
export { buildStatements, columnClause, type BuildResult } from "./diff/ddl.js";
export { orderStatements, type OrderResult, type Segment } from "./diff/order.js";
export { PHASE, type LockClass, type Statement, type Transactionality } from "./diff/statement.js";

export { buildPlan, migrationId, renderSql, ENGINE, type Plan, type PlanHazard, type PlanStatement, type Proof } from "./plan/plan.js";
export { writePlan, planSql, ProofRequiredError } from "./plan/emit.js";

export { proveOnShadowClone, type ProofResult, type ProveInput } from "./prove/prove.js";
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
  runSqlScript,
  withClient,
  withDatabase,
  type ConnInfo,
} from "./db/pg.js";

export { quoteIdent, quoteLiteral, quoteQualified } from "./sql/ident.js";

/**
 * `pg-prime` — the public surface. One import for an application file.
 *
 * ## Curated, not `export *`
 *
 * Every name below is chosen. `src/query/types.ts` is the type layer's own home and also re-exports
 * `OPS` / `CONFIRMABLE` — the operator *manifest*, which exists so the goldens, the OID
 * differential and `03` §2.9's table are generated from one list. Those are test infrastructure,
 * and `export * from './query/types.js'` would ship them as API. Likewise the AST constructors in
 * `src/compile/nodes.ts`, the planner, the emitter, `Registry`'s internals and the driver's
 * pg-protocol plumbing: they are how this library is built, not what it offers.
 *
 * The phantom-slot symbols (`META`, `OUT`, `REFS`, …) are the one apparent exception. They are
 * exported because design/04 §3.3 requires it: a `unique symbol` used in an exported type's
 * signature must itself be exported or `declaration: true` emit fails with TS2527. They carry no
 * runtime meaning and nothing outside the library needs to name them.
 *
 * ## Layout
 *
 *   schema   — `pgTable`, the column DSL, `pgEnum`, `defineRelations`, `defineSchema`
 *   sql      — the `sql` tag, fragments, identifier quoting, every error class
 *   codecs   — the built-in codecs, `Registry`, and `val(value, codec)`
 *   driver   — `pgDriver` and the connection contract
 *   query    — `pgPrime`, `compileOnly`, the ~90 operators, `fn.*`, `nest`, `over`
 *   types    — `Db`, `Query`, `Selectable`/`Insertable`/`Updateable`, `Loaded`, `Fragment`, …
 */

// ─────────────────────────────────────────────────────────────────────────────
// Schema DSL (design/05)
// ─────────────────────────────────────────────────────────────────────────────

export {
  bigint,
  boolean,
  check,
  comment,
  date,
  defineRelations,
  defineSchema,
  enumColumn,
  foreignKey,
  fragmentDdlText,
  index,
  integer,
  jsonb,
  kit,
  numeric,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  renamedFrom,
  resolveRelations,
  smallint,
  snakeCase,
  table,
  text,
  timestamptz,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from './schema/index.js'

export type {
  AnyCol,
  AnyHandle,
  AnyPgEnum,
  AnyRef,
  AnySchema,
  AnyTable,
  CheckSpec,
  Col,
  ColMeta,
  ColsAt,
  ColsOf,
  Cols,
  ColumnDdl,
  ColumnKit,
  ColumnRuntime,
  ColumnTsMeta,
  DateString,
  Defer,
  DefaultSpec,
  FkAction,
  ForeignKeyExtraInput,
  ForeignKeyOptions,
  Handle,
  Infer,
  Insert,
  InsertRow,
  Insertable,
  Loaded,
  OrmTypeError,
  PgEnum,
  PgEnumOptions,
  PgSchema,
  PgSchemaOptions,
  Projectable,
  Ref,
  RefLike,
  RefRuntime,
  RefSpec,
  Refs,
  RefsOfCols,
  RelBuilders,
  RelConfig,
  RelMeta,
  RelNode,
  RelOut,
  Rels,
  RelsAt,
  RelsRecord,
  ResolvedRelation,
  ResolvedRelations,
  ResolvedThrough,
  Row,
  Schema,
  SelAt,
  SelectRow,
  Selectable,
  Simplify,
  Table,
  TableExtra,
  TableOf,
  TableOptions,
  TableRuntime,
  Tables,
  UniqueSpec,
  Update,
  UpdateRow,
  Updateable,
} from './schema/index.js'

/**
 * The phantom slot keys. Exported for TS2527 only (design/04 §3.3) — an exported type whose
 * signature mentions a `unique symbol` needs that symbol exported, or `.d.ts` emit fails.
 */
export {
  COLS,
  DATE_BRAND,
  ERR,
  INS,
  META,
  NAME,
  OUT,
  REFS,
  RELS,
  SCHEMA,
  SEL,
  SRC,
  TABLES,
  UPD,
} from './schema/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// The `sql` tag, identifiers, and every error class (design/03 §3)
// ─────────────────────────────────────────────────────────────────────────────

export { asExpr, isFragment, sql, toNode } from './sql/index.js'
export type { AnyFragment, Fragment, SqlTag, TypedFragment } from './sql/index.js'

export {
  MAX_IDENT_BYTES,
  hasLoneSurrogate,
  hasNul,
  isValidIdentPart,
  quoteIdentPart,
  quoteIdentPath,
  quoteStringLiteral,
  utf8ByteLength,
} from './sql/index.js'

export {
  BuilderError,
  DecodePlanError,
  InvalidFragmentError,
  InvalidIdentifierError,
  NoCodecError,
  NullOperandError,
  PgPrimeError,
  SchemaError,
  TooManyParametersError,
  UnsafeLiteralError,
  UnsupportedNodeError,
} from './sql/index.js'
export type { IdentRejectReason, PgPrimeErrorCode } from './sql/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// Codecs (design/02 §4)
// ─────────────────────────────────────────────────────────────────────────────

export {
  ALTERNATE_CODECS,
  PgDecodeError,
  PgEncodeError,
  Registry,
  arrayCodec,
  arrayCodecOf,
  bitCodec,
  boolCodec,
  bpcharCodec,
  builtinCodecs,
  byteaCodec,
  charCodec,
  cidrCodec,
  createRegistry,
  dateCodec,
  daterangeCodec,
  defaultRegistry,
  enumCodec,
  float4Codec,
  float8Codec,
  inetCodec,
  int2Codec,
  int4Codec,
  int4rangeCodec,
  int8Codec,
  int8NumberCodec,
  int8StringCodec,
  int8rangeCodec,
  intervalCodec,
  jsonCodecJson,
  jsonbCodec,
  jsonpathCodec,
  macaddr8Codec,
  macaddrCodec,
  moneyCodec,
  nameCodec,
  numericCodec,
  numericNumberCodec,
  numrangeCodec,
  oidCodec,
  parseArrayLiteral,
  pgLsnCodec,
  textCodec,
  timeCodec,
  timestampCodec,
  timestamptzCodec,
  timestamptzStringCodec,
  timetzCodec,
  tsqueryCodec,
  tsrangeCodec,
  tstzrangeCodec,
  tsvectorCodec,
  unknownCodec,
  uuidCodec,
  varbitCodec,
  varcharCodec,
  writeArrayLiteral,
  xmlCodec,
} from './codec/index.js'

export type { FieldOrigin } from './compile/contract.js'

export type {
  AnyCodec,
  Codec,
  CodecContext,
  CodecIn,
  CodecOut,
  CodecPg,
  CodecRegistry,
  DynamicTypeRequest,
  JsonEncode,
  PgArrayLiteral,
  PgDateString,
  PgInterval,
  PgTimestampString,
  TypeClass,
} from './codec/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// Driver (design/02)
// ─────────────────────────────────────────────────────────────────────────────

export { PgDriverError, isServerErrorShape, normaliseError, pgDriver, toServerErrorData } from './driver/index.js'

export type {
  PgAcquireOptions,
  PgCapabilities,
  PgConnection,
  PgCopyOptions,
  PgCopyResult,
  PgDescribeResult,
  PgDriver,
  PgDriverConfig,
  PgDriverErrorData,
  PgErrorKind,
  PgExecMode,
  PgField,
  PgLikeClient,
  PgLikePool,
  PgLikeQueryConfig,
  PgLikeResult,
  PgNoticeData,
  PgNotification,
  PgParam,
  PgQuery,
  PgRawValue,
  PgResult,
  PgResultChunk,
  PgServerErrorData,
} from './driver/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// The query builder (design/03 §2)
// ─────────────────────────────────────────────────────────────────────────────

export { compileOnly, pgPrime, statementStats } from './query/run.js'
export type { PgPrimeOptions, StatementStats } from './query/run.js'

/**
 * The executor (design/09 WS6). `placeholder` is the `.prepare()` hole — a free function, like
 * every other operand producer (fork F1); `describeCacheStats` / `clearDescribeCache` are the
 * description cache's only public surface, and exist so the cache is observable rather than
 * merely claimed.
 */
export { placeholder } from './query/prepared.js'
export type { PrepareOptions, PreparedQuery } from './query/prepared.js'
export { clearDescribeCache, describeCacheStats } from './query/executor.js'
export type {
  DescribeCacheStats,
  ExecOptions,
  ExplainNode,
  ExplainOptions,
  ExplainResult,
  PreparedStatementOptions,
  StatementMode,
  StreamOptions,
} from './query/executor.js'
/** `ExecOptions.decoder` (`03` §1.3 AS BUILT) — the row builder, `'closure'` by default. */
export type { DecoderMode } from './compile/decode.js'
export type { PlaceholderRef, SqlSnapshot } from './query/terminals.js'
export type { RawQuery, RawRow } from './query/raw.js'
export { CodecMismatchError } from './query/errors.js'
export type { CodecMismatch } from './query/errors.js'

/**
 * The operator vocabulary (`03` §2.9) and the combinators, ordering and aggregates (`03` §2.4).
 *
 * Enumerated rather than `export *` for one name: `ops.ts` also exports `RANGE_ELEMENT_NAMES`,
 * which exists so `test/query/ops.test.ts` can pin the runtime subtype table against its
 * type-level twin. It is a test fixture, and a barrel that shipped it would make it API.
 */
export {
  abs,
  add,
  adjacent,
  allOf,
  anyOf,
  arrayConcat,
  arrayContainedBy,
  arrayContains,
  arrayLength,
  between,
  cast,
  coalesce,
  concat,
  containedByNet,
  containsNet,
  div,
  eq,
  gt,
  gte,
  has,
  hasAll,
  hasAllKeys,
  hasAnyKey,
  hasKey,
  ilike,
  inList,
  inQuery,
  iregex,
  isDistinctFrom,
  isFalse,
  isNotDistinctFrom,
  isNotFalse,
  isNotNull,
  isNotTrue,
  isNull,
  isTrue,
  jsonConcat,
  jsonContainedBy,
  jsonContains,
  jsonDelete,
  jsonDeletePath,
  jsonGet,
  jsonGetText,
  jsonPath,
  jsonPathExists,
  jsonPathMatch,
  jsonPathText,
  like,
  lt,
  lte,
  matches,
  mod,
  mul,
  neq,
  notILike,
  notIRegex,
  notInList,
  notLike,
  notRegex,
  overlaps,
  overlapsNet,
  rangeContainedBy,
  rangeContains,
  rangeIntersection,
  rangeLower,
  rangeOverlaps,
  rangeUnion,
  rangeUpper,
  regex,
  similarTo,
  startsWith,
  strictlyLeft,
  strictlyRight,
  sub,
  tsRank,
  tsRankCd,
  val,
} from './query/ops.js'
export {
  and,
  asc,
  desc,
  exists,
  fn,
  not,
  notExists,
  or,
  toOrderItem,
} from './query/fn.js'
export type { Fn } from './query/fn.js'

export { nest, nestNullable } from './query/projection.js'
export { over } from './query/window.js'
export type { Bound, FrameOpts, WindowFn, WindowLiteral, WindowSpec } from './query/window.js'

export type {
  AnyOperand,
  ArrayOperand,
  BoolOperand,
  ClassOperand,
  JsonOperand,
  JsonbOperand,
  NetOperand,
  NonNullOperand,
  NumOperand,
  NumPg,
  Order,
  OrderArg,
  OrderBy,
  RangeOperand,
  RangePg,
  TextOperand,
  TextPg,
  TsqueryOperand,
  TsvectorOperand,
} from './query/types.js'

export { SELECT_SOURCE } from './query/types.js'

export type {
  AnyQuery,
  BulkOpts,
  ColsAtH,
  ConflictBuilder,
  CteExecutor,
  CteHandle,
  Db,
  DeleteQuery,
  Executor,
  Expr,
  ExprOf,
  FromValuesOpts,
  GroupedQuery,
  Grouping,
  InferResult,
  InsertPatch,
  InsertQuery,
  LockOpts,
  ManyRel,
  NullRef,
  NullRow,
  OneRel,
  Operand,
  PkOf,
  Project,
  ProjectPreJoin,
  Projection,
  Query,
  RefsAt,
  RefsOf,
  RelAccessor,
  RelAggs,
  RelOpts,
  RelPickers,
  ResultRefs,
  RowOf,
  RowSource,
  ScopeOf,
  SelectAt,
  SelectSource,
  SetOps,
  SetPatch,
  SetQuery,
  Sources,
  SubQuery,
  SchemaExecutor,
  TableAt,
  UpdateQuery,
  ValueRefs,
  WithOpts,
} from './query/types.js'

// Phantom slot keys — MUST all be exported (design/04 §3.3, TS2527).
export {
  COLS,
  DATE_BRAND,
  ERR,
  INS,
  META,
  NAME,
  OUT,
  READONLY,
  REFS,
  RELS,
  SCHEMA,
  SEL,
  SRC,
  TABLES,
  UPD,
} from './symbols.js'

export type {
  ColMeta,
  Cols,
  DateString,
  Defer,
  InsertRow,
  OrmTypeError,
  RelMeta,
  Rels,
  SelectRow,
  Simplify,
  UpdateRow,
} from './types.js'

export type { AnyRef, Projectable, Ref, RefRuntime, RefsOfCols } from './ref.js'

export { fragmentDdlText } from './ddl.js'
export type { CheckSpec, FkAction, ForeignKeyOptions, RefLike, RefSpec, UniqueSpec } from './ddl.js'

export {
  VECTOR_MAX_DIMENSIONS,
  bigint,
  boolean,
  citext,
  date,
  enumColumn,
  integer,
  jsonb,
  kit,
  numeric,
  pgEnum,
  raw,
  smallint,
  text,
  timestamptz,
  uuid,
  varchar,
  vector,
} from './column.js'
export type {
  AnyCol,
  AnyPgEnum,
  Col,
  ColumnDdl,
  ColumnKit,
  ColumnRuntime,
  ColumnTsMeta,
  DefaultSpec,
  GeneratedAlwaysAsOptions,
  Infer,
  PgEnum,
  PgEnumOptions,
} from './column.js'

export {
  check,
  clusterOn,
  comment,
  exclude,
  foreignKey,
  index,
  partitionBy,
  partitionOf,
  primaryKey,
  renamedFrom,
  unique,
  uniqueIndex,
} from './extras.js'
export type {
  ExcludeItem,
  ExcludePair,
  ForeignKeyExtraInput,
  IndexColumn,
  IndexColumnLike,
  IndexExpression,
  IndexItem,
  IndexNulls,
  IndexOptions,
  PartitionOfOptions,
  PrimaryKeyInput,
  StorageParameters,
  TableExtra,
} from './extras.js'

export { pgDomain, pgExtension, pgSequence } from './objects.js'
export type {
  PgDomain,
  PgDomainOptions,
  PgExtension,
  PgExtensionOptions,
  PgSequence,
  PgSequenceOptions,
} from './objects.js'

export { pgSchema, pgTable, snakeCase, table } from './table.js'
export type {
  AnyTable,
  ColsOf,
  Insert,
  Insertable,
  PgSchema,
  PgSchemaOptions,
  Refs,
  Row,
  Selectable,
  Table,
  TableOptions,
  TableRuntime,
  Update,
  Updateable,
} from './table.js'

export { isView, pgMaterializedView, pgView } from './view.js'
export type {
  AnyMaterializedView,
  AnyView,
  MaterializedView,
  MaterializedViewBody,
  MaterializedViewBuilder,
  MaterializedViewRuntime,
  RefreshableOptions,
  View,
  ViewBody,
  ViewBuilder,
  ViewDependency,
  ViewInfo,
  ViewOptions,
  ViewRow,
  ViewRuntime,
  ViewSchema,
  ViewTable,
  ViewWithOptions,
} from './view.js'

export { defineRelations, defineSchema, resolveRelations } from './relations.js'
export type {
  AnyHandle,
  AnySchema,
  ColsAt,
  Handle,
  Loaded,
  RelBuilders,
  RelConfig,
  RelNode,
  RelOut,
  RelsAt,
  RelsRecord,
  ResolvedRelation,
  ResolvedRelations,
  ResolvedThrough,
  Schema,
  SelAt,
  TableOf,
  Tables,
} from './relations.js'

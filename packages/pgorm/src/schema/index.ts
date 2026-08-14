// Phantom slot keys — MUST all be exported (design/04 §3.3, TS2527).
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

export {
  bigint,
  boolean,
  date,
  enumColumn,
  integer,
  jsonb,
  kit,
  numeric,
  pgEnum,
  smallint,
  text,
  timestamptz,
  uuid,
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
  Infer,
  PgEnum,
} from './column.js'

export { comment, index, primaryKey, uniqueIndex } from './extras.js'
export type { TableExtra } from './extras.js'

export { pgTable, snakeCase, table } from './table.js'
export type {
  AnyTable,
  ColsOf,
  Insert,
  Insertable,
  Refs,
  Row,
  Selectable,
  Table,
  TableOptions,
  TableRuntime,
  Update,
  Updateable,
} from './table.js'

export { defineRelations, defineSchema } from './relations.js'
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
  Schema,
  SelAt,
  TableOf,
  Tables,
} from './relations.js'

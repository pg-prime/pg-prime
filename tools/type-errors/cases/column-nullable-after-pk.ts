// E12: `.nullable()` after `.primaryKey()` is a contradiction the DDL cannot express.
import { uuid } from '../../../packages/pg-prime/src/schema/index.js'
export const bad = uuid().primaryKey().nullable()

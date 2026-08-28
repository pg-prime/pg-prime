/**
 * The structural view the kit takes of a `pg-prime` schema (design/11 §1.3).
 *
 * **Types only.** `pg-prime` is a `peerDependency`, never a runtime import: the user's config
 * imports their own copy of the DSL, and the kit reads the runtime metadata it produces
 * structurally. `test/schema-emit/no-value-import.test.ts` greps `src/` and fails on a value
 * import, because a type-only rule that is only a convention is a rule that lasts one refactor.
 *
 * Everything below is `pg-prime`'s own exported types, re-shaped into the *minimum* the emitter
 * consumes. Taking `Schema<T, R>` itself would drag the whole generic type layer into the kit for
 * no benefit: the emitter never looks at a column's TypeScript type, only at its `ColumnDdl`.
 */

import type {
  ColumnDdl,
  PgDomain,
  PgEnum,
  PgExtension,
  PgSchema,
  PgSequence,
  RefRuntime,
  TableExtra,
  TableRuntime,
} from "pg-prime";

export type {
  ColumnDdl,
  PgDomain,
  PgEnum,
  PgExtension,
  PgSchema,
  PgSequence,
  RefRuntime,
  TableExtra,
  TableRuntime,
};

/** One table, as `defineSchema(...)`'s registry holds it. */
export interface TableLike {
  readonly $: TableRuntime;
}

/**
 * A schema registry: `defineSchema({ users, orgs })`.
 *
 * `Schema<T, R>` from `pg-prime` is assignable to this — `tables` is its public property — and so
 * is a bare `{ tables: { users, orgs } }`, which is what makes the emitter testable without
 * building a registry.
 */
export interface SchemaLike {
  readonly tables: Readonly<Record<string, TableLike>>;
  /**
   * The standalone objects `defineSchema` does not carry (design/06 §2.2 Tier M:
   * `type` — enum, domain, composite — `sequence` and `extension`), plus the `pgSchema`
   * declarations, collected by `loadConfig`'s `loadSchema` off the module's own exports.
   *
   * They are NOT properties of `defineSchema(...)`: adding them there would change a
   * signature the query layer owns, for objects the query layer never looks at. The kit
   * already discovers tables by walking a module's exports, and these are discovered the
   * same way, which is also why they are optional here — a `{ tables }` literal is still
   * a `SchemaLike`, and every existing emitter test still is one.
   */
  readonly enums?: readonly PgEnum<string, readonly string[]>[];
  readonly domains?: readonly PgDomain[];
  readonly sequences?: readonly PgSequence[];
  readonly extensions?: readonly PgExtension[];
  readonly schemas?: readonly PgSchema[];
}

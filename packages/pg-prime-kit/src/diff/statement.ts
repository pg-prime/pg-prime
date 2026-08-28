/** Reported, never certified (design/06 §1.2). */
export type LockClass =
  | "accessExclusive"
  | "shareRowExclusive"
  | "share"
  | "shareUpdateExclusive"
  | "rowExclusive"
  | "none";

/**
 * Three-valued transactionality. The third value exists for
 * `ALTER TYPE … ADD VALUE`, which IS transactional but whose new value is
 * unusable until commit — so a segment must close after it.
 */
export type Transactionality = "transactional" | "nonTransactional" | "commitBoundaryAfter";

/**
 * Which FILE of one `generate` run a statement belongs to (design/06 §3.5 rows 1/6/7,
 * §4.1 "duplicate numbers are legal").
 *
 * The three lock-safe rewrites design/11 K3 could not build were all blocked on the same
 * thing: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so a plan that
 * contains one cannot also be an atomic DDL file. Splitting the plan across two files at
 * the same `seq` — `NNNN_name.sql` and `NNNN_name_concurrently.sql`, ordered by
 * `(seq, name)` — is what unblocks them, and this field is how the differ says which
 * half a statement belongs to. `undefined` means `"main"`.
 *
 * `"data"` is the §3.5 row-7 backfill stub: a `-- pg-prime:data` file with a TODO, never
 * an `UPDATE` the generator invented.
 */
export type Stage = "main" | "concurrent" | "data";

export interface Statement {
  readonly sql: string;
  readonly verb: "create" | "alter" | "drop";
  readonly kind: string;
  readonly produces: readonly string[];
  readonly consumes: readonly string[];
  readonly destroys: readonly string[];
  readonly releases: readonly string[];
  readonly transactionality: Transactionality;
  readonly lockClass: LockClass;
  readonly idempotent: boolean;
  readonly dataLoss: "none" | "destructive";
  readonly rewrite: boolean;
  readonly hazards: readonly string[];
  /** coarse dependency stratum, used as the tie-break priority in ordering */
  readonly phase: number;
  /** which emitted file this statement belongs to; absent = `"main"` */
  readonly stage?: Stage;
}

export const PHASE = {
  createExtension: -1,
  createSchema: 0,
  alterExtension: 1,
  rename: 2,
  createType: 5,
  alterType: 6,
  addEnumValue: 10,
  dropIndex: 15,
  dropConstraint: 20,
  /**
   * The `DROP INDEX CONCURRENTLY IF EXISTS` prefix of a design/06 §3.5 row-6 group.
   *
   * It has to run AFTER the `ALTER TABLE … DROP CONSTRAINT IF EXISTS` beside it and before
   * the concurrent build, and the reason is a replay: §5.4 restarts a `txmode none` file at
   * statement 0, so on the second pass the constraint may already own the index — and
   * `DROP INDEX` on a constraint's index raises "cannot drop index … because constraint …
   * requires it". Dropping the constraint first takes the index with it.
   */
  dropIndexConcurrently: 21,
  detachPartition: 22,
  createSequence: 25,
  createTable: 30,
  addColumn: 35,
  alterTable: 38,
  alterColumn: 40,
  setDefault: 41,
  alterSequence: 42,
  dropColumn: 45,
  addConstraint: 50,
  addForeignKey: 52,
  validateConstraint: 55,
  attachPartition: 58,
  createIndex: 60,
  comment: 65,
  dropTable: 70,
  dropSequence: 75,
  dropType: 80,
  dropSchema: 85,
} as const;

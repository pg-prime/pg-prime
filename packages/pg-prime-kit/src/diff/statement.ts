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

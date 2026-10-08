/**
 * RLS before/after state and per-(table, role, command) coverage (design/20 D25, §6 RL101/RL108).
 * Same names and shapes as the readers in `catalog/extract.ts`; this module goes once those land.
 */

import type { CatalogClient } from "../catalog/extract.js";
import { encodeId } from "../ir/stable-id.js";

export type RlsCommand = "select" | "insert" | "update" | "delete";
export const RLS_COMMANDS: readonly RlsCommand[] = ["select", "insert", "update", "delete"];

export interface TableRlsState {
  readonly schema: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly forced: boolean;
  readonly owner: string;
}

export interface PolicyState {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly command: "all" | RlsCommand;
  readonly permissive: boolean;
  /** role names, `public` for PUBLIC */
  readonly roles: readonly string[];
  /** the `pg-prime:declared …` comment, null on an unmarked policy */
  readonly marker: string | null;
}

export interface LaneState {
  readonly tables: readonly TableRlsState[];
  readonly policies: readonly PolicyState[];
  /** role → every role it is a member of, itself included */
  readonly memberOf: ReadonlyMap<string, readonly string[]>;
  /** superusers and `BYPASSRLS` roles */
  readonly bypass: ReadonlySet<string>;
}

const COMMAND: Readonly<Record<string, PolicyState["command"]>> = {
  r: "select",
  a: "insert",
  w: "update",
  d: "delete",
  "*": "all",
};

/** `reverse` maps shadow schemas back to the user's (tier 3). */
export async function readLaneState(
  client: CatalogClient,
  schemas: readonly string[],
  reverse: ReadonlyMap<string, string> = new Map(),
): Promise<LaneState> {
  const sch = (s: string): string => reverse.get(s) ?? s;
  const tables = await client.query(
    `SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            pg_get_userbyid(c.relowner)::text AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1)`,
    [[...schemas]],
  );
  const policies = await client.query(
    `SELECT n.nspname AS schema, c.relname AS "table", p.polname AS name, p.polcmd::text AS cmd,
            p.polpermissive AS permissive, obj_description(p.oid, 'pg_policy') AS comment,
            ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END FROM unnest(p.polroles) r) AS roles
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1)`,
    [[...schemas]],
  );
  const roles = await client.query(
    `SELECT r.rolname::text AS role, r.rolsuper OR r.rolbypassrls AS bypass,
            ARRAY(SELECT g.rolname::text FROM pg_roles g WHERE pg_has_role(r.oid, g.oid, 'MEMBER')) AS member_of
       FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\\_%'`,
  );
  type R = { role: string; bypass: boolean; member_of: string[] };
  return {
    tables: (tables.rows as unknown as TableRlsState[]).map((t) => ({ ...t, schema: sch(t.schema) })),
    policies: (
      policies.rows as {
        schema: string;
        table: string;
        name: string;
        cmd: string;
        permissive: boolean;
        comment: string | null;
        roles: string[];
      }[]
    ).map((p) => ({
      schema: sch(p.schema),
      table: p.table,
      name: p.name,
      command: COMMAND[p.cmd] ?? "all",
      permissive: p.permissive,
      roles: p.roles,
      marker: p.comment?.startsWith("pg-prime:declared ") === true ? p.comment : null,
    })),
    memberOf: new Map((roles.rows as R[]).map((r) => [r.role, r.member_of])),
    bypass: new Set((roles.rows as R[]).filter((r) => r.bypass).map((r) => r.role)),
  };
}

/** D25: the shadow's policies plus every unmarked target policy the shadow lacks; owners and roles are the target's. */
export function afterLaneState(target: LaneState, shadow: LaneState): LaneState {
  const owner = new Map(target.tables.map((t) => [`${t.schema}.${t.name}`, t.owner]));
  const inShadow = new Set(shadow.policies.map((p) => `${p.schema}.${p.table}.${p.name}`));
  return {
    tables: shadow.tables.map((t) => ({ ...t, owner: owner.get(`${t.schema}.${t.name}`) ?? t.owner })),
    policies: [
      ...shadow.policies,
      ...target.policies.filter((p) => p.marker === null && !inShadow.has(`${p.schema}.${p.table}.${p.name}`)),
    ],
    memberOf: target.memberOf,
    bypass: target.bypass,
  };
}

export interface CoverageLoss {
  readonly code: "RL101" | "RL108";
  readonly schema: string;
  readonly table: string;
  readonly role: string;
  readonly command: RlsCommand;
  /** `<schema>.<table>:<role>:<command>` */
  readonly subject: string;
}

/** Does a permissive policy give `role` this command on the table (PUBLIC, itself, or a role it is in)? */
export function covers(state: LaneState, schema: string, table: string, role: string, command: RlsCommand): boolean {
  const groups = role === "public" ? ["public"] : ["public", ...(state.memberOf.get(role) ?? [role])];
  return state.policies.some(
    (p) =>
      p.schema === schema &&
      p.table === table &&
      p.permissive &&
      (p.command === "all" || p.command === command) &&
      p.roles.some((r) => groups.includes(r)),
  );
}

/** RL101/RL108 per (table, role, command) on tables RLS-enabled after, present before and not empty. */
export function coverageLost(before: LaneState, after: LaneState, emptyTables: ReadonlySet<string>): CoverageLoss[] {
  const out: CoverageLoss[] = [];
  const prior = new Map(before.tables.map((t) => [`${t.schema}.${t.name}`, t]));
  const lose = (code: CoverageLoss["code"], t: TableRlsState, role: string, command: RlsCommand): void => {
    out.push({
      code,
      schema: t.schema,
      table: t.name,
      role,
      command,
      subject: `${t.schema}.${t.name}:${role}:${command}`,
    });
  };
  for (const t of after.tables) {
    const was = prior.get(`${t.schema}.${t.name}`);
    if (!t.enabled || was === undefined) continue;
    if (emptyTables.has(encodeId({ kind: "table", schema: t.schema, name: t.name }))) continue;
    const on = (p: PolicyState): boolean => p.schema === t.schema && p.table === t.name && p.permissive;
    if (!was.enabled) {
      if (!after.policies.some(on)) for (const c of RLS_COMMANDS) lose("RL101", t, "public", c);
    } else {
      const roles = [...new Set(before.policies.filter(on).flatMap((p) => p.roles))].sort();
      for (const role of roles.filter((r) => r !== t.owner && !after.bypass.has(r))) {
        for (const c of RLS_COMMANDS) {
          if (covers(before, t.schema, t.name, role, c) && !covers(after, t.schema, t.name, role, c))
            lose("RL101", t, role, c);
        }
      }
    }
    if (t.forced && !after.bypass.has(t.owner)) {
      for (const c of RLS_COMMANDS) {
        const had = !was.enabled || !was.forced || covers(before, t.schema, t.name, t.owner, c);
        if (had && !covers(after, t.schema, t.name, t.owner, c)) lose("RL108", t, t.owner, c);
      }
    }
  }
  return out;
}

/**
 * design/20 §6 RL101/RL108 on synthetic state: coverage is per (table, role, command), on the
 * D25 after-state, so a hand-written or unmanaged policy counts and a single-command loss shows.
 */

import { describe, expect, it } from "vitest";
import {
  afterLaneState,
  coverageLost,
  covers,
  type LaneState,
  type PolicyState,
  type TableRlsState,
} from "../../src/catalog/extract.js";

const table = (over: Partial<TableRlsState> = {}): TableRlsState => ({
  schema: "public",
  name: "documents",
  enabled: true,
  forced: false,
  owner: "owner_role",
  ...over,
});

const policy = (name: string, over: Partial<PolicyState> = {}): PolicyState => ({
  schema: "public",
  table: "documents",
  name,
  command: "all",
  permissive: true,
  roles: ["app_user"],
  using: "true",
  withCheck: null,
  marker: null,
  dependsOn: [],
  ...over,
});

const state = (tables: TableRlsState[], policies: PolicyState[], over: Partial<LaneState> = {}): LaneState => ({
  tables,
  policies,
  updatedAtTriggers: [],
  memberOf: new Map([
    ["app_user", ["app_user"]],
    ["app_admin", ["app_admin", "app_user"]],
    ["owner_role", ["owner_role"]],
  ]),
  bypass: new Set(["postgres"]),
  ...over,
});

const subjects = (before: LaneState, after: LaneState, empty: string[] = []): string[] =>
  coverageLost(before, after, new Set(empty)).map((l) => `${l.code} ${l.subject}`);

describe("coverageLost", () => {
  it("ENABLE with no permissive policy at all loses every command for public", () => {
    expect(subjects(state([table({ enabled: false })], []), state([table()], []))).toEqual([
      "RL101 public.documents:public:select",
      "RL101 public.documents:public:insert",
      "RL101 public.documents:public:update",
      "RL101 public.documents:public:delete",
    ]);
    expect(subjects(state([table({ enabled: false })], []), state([table()], [policy("p")]))).toEqual([]);
  });

  it("a proven-empty table, a table created by the change and a disabled one are skipped", () => {
    expect(subjects(state([table({ enabled: false })], []), state([table()], []), ["table:public.documents"])).toEqual(
      [],
    );
    expect(subjects(state([], []), state([table()], []))).toEqual([]);
    expect(subjects(state([table()], [policy("p")]), state([table({ enabled: false })], []))).toEqual([]);
  });

  it("removing only the SELECT policy is flagged for SELECT alone", () => {
    const before = state([table()], [policy("r", { command: "select" }), policy("w", { command: "insert" })]);
    const after = state([table()], [policy("w", { command: "insert" })]);
    expect(subjects(before, after)).toEqual(["RL101 public.documents:app_user:select"]);
  });

  it("ALL split into per-command policies keeps coverage; ALL narrowed to SELECT does not", () => {
    const before = state([table()], [policy("all")]);
    const split = state(
      [table()],
      (["select", "insert", "update", "delete"] as const).map((c) => policy(c, { command: c })),
    );
    expect(subjects(before, split)).toEqual([]);
    expect(subjects(before, state([table()], [policy("select", { command: "select" })]))).toEqual([
      "RL101 public.documents:app_user:insert",
      "RL101 public.documents:app_user:update",
      "RL101 public.documents:app_user:delete",
    ]);
  });

  it("coverage comes from PUBLIC, the role itself or a role it is a member of; restrictive grants nothing", () => {
    const before = state([table()], [policy("p", { roles: ["app_admin"] })]);
    expect(subjects(before, state([table()], [policy("q", { roles: ["public"] })]))).toEqual([]);
    expect(subjects(before, state([table()], [policy("q", { roles: ["app_user"] })]))).toEqual([]);
    expect(subjects(before, state([table()], [policy("q", { roles: ["app_admin"], permissive: false })]))).toHaveLength(
      4,
    );
    const s = state([table()], [policy("q", { roles: ["app_user"] })]);
    expect(covers(s, "public", "documents", "app_admin", "select")).toBe(true);
    expect(covers(s, "public", "documents", "public", "select")).toBe(false);
  });

  it("losing a PUBLIC policy is a loss for public; a bypassing role never loses", () => {
    expect(
      subjects(state([table()], [policy("p", { roles: ["public"], command: "select" })]), state([table()], [])),
    ).toEqual(["RL101 public.documents:public:select"]);
    expect(
      subjects(state([table()], [policy("p", { roles: ["postgres"], command: "select" })]), state([table()], [])),
    ).toEqual([]);
  });

  it("RL108: FORCE takes the owner's bypass away unless a policy covers it", () => {
    const after = state([table({ forced: true })], [policy("p", { command: "select" })]);
    expect(subjects(state([table()], [policy("p", { command: "select" })]), after)).toEqual([
      "RL108 public.documents:owner_role:select",
      "RL108 public.documents:owner_role:insert",
      "RL108 public.documents:owner_role:update",
      "RL108 public.documents:owner_role:delete",
    ]);
    const owned = state([table({ forced: true })], [policy("p", { roles: ["owner_role"] })]);
    expect(subjects(state([table()], []), owned)).toEqual([]);
    // already FORCE'd, the owner had only what policies gave it
    const was = state([table({ forced: true })], [policy("o", { roles: ["owner_role"], command: "select" })]);
    expect(subjects(was, state([table({ forced: true })], []))).toEqual(["RL108 public.documents:owner_role:select"]);
    expect(subjects(state([table()], []), state([table({ forced: true, owner: "postgres" })], []))).toEqual([]);
  });
});

describe("afterLaneState", () => {
  it("is the shadow's policies plus unmarked target policies the shadow lacks, with the target's owners", () => {
    const target = state(
      [table({ owner: "owner_role" })],
      [
        policy("hand"),
        policy("pruned", { marker: "pg-prime:declared sha256:aa" }),
        policy("redeclared", { marker: "pg-prime:declared sha256:bb", using: "false" }),
      ],
    );
    const shadow = state([table({ owner: "shadow_role", forced: true })], [policy("redeclared"), policy("new")], {
      memberOf: new Map(),
      bypass: new Set(),
    });
    const after = afterLaneState(target, shadow);
    expect(after.policies.map((p) => p.name)).toEqual(["redeclared", "new", "hand"]);
    expect(after.policies[0]?.using).toBe("true");
    expect(after.tables).toEqual([table({ owner: "owner_role", forced: true })]);
    expect(after.memberOf).toBe(target.memberOf);
    expect(after.bypass).toBe(target.bypass);
  });
});

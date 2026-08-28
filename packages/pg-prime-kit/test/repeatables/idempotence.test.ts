/**
 * TX201, as the two files a reviewer would write by hand: one that must pass and one that must
 * fail, at named indices.
 *
 * The passing file is deliberately the awkward one. It contains a `plpgsql` body holding a `;`,
 * a `--` and a bare `DROP TABLE`, all of which a regex over the raw text would read as
 * top-level non-idempotent SQL — that false alarm is the failure mode that gets a lint rule
 * switched off, and it lands on the exact spelling design/06 §3.8 prescribes.
 */

import { describe, expect, it } from "vitest";
import { checkIdempotence } from "../../src/repeatables/idempotence.js";
import { splitStatements } from "../../src/sql/statements.js";

const IDEMPOTENT = `
-- pg-prime:owner platform
CREATE OR REPLACE FUNCTION public.bump() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  -- kept verbatim in prosrc; the DROP below is the body's business, not TX201's
  DROP TABLE public.decoy;
  NEW.updated_at := now();
  RETURN NEW;
END;
$body$;

DROP TRIGGER IF EXISTS users_bump ON public.users;
CREATE TRIGGER users_bump BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.bump();

DROP POLICY IF EXISTS users_self ON public.users;
CREATE POLICY users_self ON public.users USING (id = current_setting('app.user_id')::bigint);

CREATE TABLE IF NOT EXISTS public.audit (id bigint);
CREATE OR REPLACE VIEW public.active_users AS SELECT 1 AS n;
DROP VIEW IF EXISTS public.legacy_users;

ALTER TABLE public.orders VALIDATE CONSTRAINT orders_total_check;
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'refunded';

COMMENT ON VIEW public.active_users IS 'users seen this week';
GRANT SELECT ON public.active_users TO PUBLIC;
REVOKE INSERT ON public.active_users FROM PUBLIC;
SECURITY LABEL ON FUNCTION public.bump() IS NULL;
SET search_path = pg_catalog;
SELECT pg_catalog.set_config('search_path', 'pg_catalog', true);
DO $$ BEGIN PERFORM 1; END $$;
ANALYZE public.audit;
REINDEX INDEX public.audit_pkey;
TRUNCATE public.audit;
INSERT INTO public.audit (id) VALUES (1) ON CONFLICT DO NOTHING;
`;

const NOT_IDEMPOTENT = `
CREATE TABLE public.users (id bigint PRIMARY KEY);
CREATE INDEX users_email_idx ON public.users (email);
DROP VIEW public.legacy_users;
INSERT INTO public.seed (id) VALUES (1);
UPDATE public.users SET flag = true;
DELETE FROM public.users WHERE id = 1;
ALTER TYPE public.order_status ADD VALUE 'refunded';
CREATE OR REPLACE VIEW public.fine AS SELECT 1;
`;

describe("checkIdempotence", () => {
  it("accepts every repeatable form design/06 §3.8 prescribes", () => {
    const statements = splitStatements(IDEMPOTENT);
    const result = checkIdempotence(statements);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    // the body did not become its own statement
    expect(statements[0]).toContain("DROP TABLE public.decoy");
  });

  it("names every non-idempotent statement, at its index", () => {
    const statements = splitStatements(NOT_IDEMPOTENT);
    const result = checkIdempotence(statements);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.violations[0]?.sql).toContain("CREATE TABLE public.users");
    expect(result.violations[0]?.reason).toMatch(/bare CREATE/);
    expect(result.violations[2]?.reason).toMatch(/bare DROP/);
    expect(result.violations[3]?.reason).toMatch(/ON CONFLICT/);
    expect(result.violations[4]?.reason).toMatch(/^UPDATE/);
    expect(result.violations[5]?.reason).toMatch(/^DELETE/);
    expect(result.violations[6]?.reason).toMatch(/ADD VALUE/);
    // the last statement is fine and must not be swept up
    expect(result.violations.some((v) => v.index === 7)).toBe(false);
  });

  it("a DROP inside a function body is not a DROP statement", () => {
    const body = splitStatements(
      `CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$
       BEGIN
         DROP TABLE public.decoy;
         DELETE FROM public.decoy;
       END;
       $$;`,
    );
    expect(body).toHaveLength(1);
    expect(checkIdempotence(body).ok).toBe(true);
  });

  it("a comment cannot launder a statement, and a literal cannot fake one", () => {
    // the `OR REPLACE` is in a comment; the statement is still a bare CREATE
    expect(checkIdempotence(["-- CREATE OR REPLACE\nCREATE VIEW v AS SELECT 1"]).ok).toBe(false);
    // and a leading comment must not hide a perfectly good statement either
    expect(checkIdempotence(["-- rebuild the view\nCREATE OR REPLACE VIEW v AS SELECT 1"]).ok).toBe(true);
    // 'ON CONFLICT' as DATA is not an ON CONFLICT clause
    expect(checkIdempotence(["INSERT INTO t (note) VALUES ('ON CONFLICT DO NOTHING')"]).ok).toBe(false);
    // …and neither is an IF EXISTS spelled inside a string
    expect(checkIdempotence(["DROP TABLE t /* IF EXISTS */"]).ok).toBe(false);
  });

  it("pairs DROP … IF EXISTS with the CREATE of the same object", () => {
    // the idiom of `06` §3.8 for the kinds with no CREATE OR REPLACE
    expect(
      checkIdempotence([
        "DROP TRIGGER IF EXISTS users_bump ON public.users",
        "CREATE TRIGGER users_bump BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.bump()",
      ]).ok,
    ).toBe(true);
    // and `DROP INDEX CONCURRENTLY IF EXISTS` with `CREATE UNIQUE INDEX`, noise words aside
    expect(
      checkIdempotence([
        "DROP INDEX CONCURRENTLY IF EXISTS public.users_email_idx",
        "CREATE UNIQUE INDEX users_email_idx ON public.users (email)",
      ]).ok,
    ).toBe(true);

    // a DROP of a DIFFERENT object excuses nothing…
    expect(
      checkIdempotence([
        "DROP TRIGGER IF EXISTS other_trigger ON public.users",
        "CREATE TRIGGER users_bump BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.bump()",
      ]).ok,
    ).toBe(false);
    // …nor does one that comes after
    expect(
      checkIdempotence([
        "CREATE TRIGGER users_bump BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.bump()",
        "DROP TRIGGER IF EXISTS users_bump ON public.users",
      ]).ok,
    ).toBe(false);
  });

  it("an unrecognised verb is not evidence of non-idempotence", () => {
    // saying "I do not know this statement" by failing it is how a rule becomes noise
    expect(checkIdempotence(["VACUUM public.users", "WITH x AS (SELECT 1) SELECT * FROM x"]).ok).toBe(true);
    expect(checkIdempotence([]).ok).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(checkIdempotence(["create or replace view v as select 1"]).ok).toBe(true);
    expect(checkIdempotence(["drop table if exists t"]).ok).toBe(true);
    expect(checkIdempotence(["Create View v As Select 1"]).ok).toBe(false);
  });
});

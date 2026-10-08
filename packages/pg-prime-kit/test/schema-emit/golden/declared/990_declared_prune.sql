-- pg-prime:declared prune
-- pg-prime:tier R
--
-- Drops objects carrying a 'pg-prime:declared' comment in the schemas below that are no longer
-- declared. Hand-written objects never carry the marker and are never touched.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, p.polname AS o
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY (ARRAY['public'])
       AND obj_description(p.oid, 'pg_policy') LIKE 'pg-prime:declared %'
       AND (n.nspname, c.relname, p.polname) NOT IN (VALUES
         ('public', 'documents', 'archived_read_only'),
         ('public', 'documents', 'shared'),
         ('public', 'documents', 'tenant'))
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.o, r.s, r.t);
  END LOOP;
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, g.tgname AS o
      FROM pg_trigger g
      JOIN pg_class c ON c.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT g.tgisinternal
       AND n.nspname = ANY (ARRAY['public'])
       AND obj_description(g.oid, 'pg_trigger') LIKE 'pg-prime:declared %'
       AND (n.nspname, c.relname, g.tgname) NOT IN (VALUES
         ('public', 'documents', 'pgprime_set_updated_at'))
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %I.%I', r.o, r.s, r.t);
  END LOOP;
  FOR r IN
    SELECT n.nspname AS s, p.proname AS o
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.pronargs = 0
       AND n.nspname = ANY (ARRAY['public'])
       AND obj_description(p.oid, 'pg_proc') LIKE 'pg-prime:declared %'
       AND (n.nspname, p.proname) NOT IN (VALUES
         ('public', 'pgprime_set_updated_at'))
  LOOP
    EXECUTE format('DROP FUNCTION %I.%I()', r.s, r.o);
  END LOOP;
END
$$;

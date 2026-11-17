import type { Tx } from 'pg-prime'

type Snapshot = Record<string, string | null>

/** User-settable built-ins plus the host's keys: placeholders never appear in `pg_settings`. */
export async function capture(tx: Tx, keys: Iterable<string>): Promise<Snapshot> {
  const row = await tx.sql`select jsonb_object_agg(name, current_setting(name, true))::text as s
    from (select name from pg_settings where context = 'user'
          union select jsonb_array_elements_text(${JSON.stringify([...keys])}::jsonb)) n`.executeTakeFirst()
  return JSON.parse(row!['s'] as string) as Snapshot
}

/** Back to the snapshot before `RELEASE` keeps the request's values. Keys learned since were unset. */
export async function restore(tx: Tx, before: Snapshot, keys: Iterable<string>): Promise<void> {
  const all = { ...before }
  for (const k of keys) if (!(k in all)) all[k] = null
  await tx.sql`select count(set_config(key, coalesce(value, ''), true))
    from jsonb_each_text(${JSON.stringify(all)}::jsonb)
    where current_setting(key, true) is distinct from value`.execute()
}

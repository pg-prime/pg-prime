---
'@pg-prime/kit': minor
---

The migration side of design/01 §3 rows **49**, **50**, **51** and **54**: the four object kinds
the DSL learned this round now emit, diff and `pull`.

`emitSchema` writes `EXCLUDE USING … (elem WITH op) WHERE … DEFERRABLE`, `GENERATED ALWAYS AS (…)
STORED`, an index's `(expression)` keys, `WITH (…)` (sorted, text values quoted) and `TABLESPACE`,
and `COMMENT ON TYPE` for a `pgEnum` / `pgDomain` comment. An `exclude(...).requires('btree_gist')`
whose extension the registry does not declare is an error diagnostic naming the declaration to add,
rather than a `42704` about an operator class three steps later on the shadow.

`pg-prime pull`'s residue list shrinks by four kinds: an exclusion constraint, a stored generated
column, an expression index key, and an index's `WITH (…)` / `TABLESPACE`. What it still cannot
express keeps an exact reason — an EXCLUDE element carrying an opclass, a key this recogniser
cannot split with certainty, `attgenerated = 'v'`.

`BuildOptions.noConcurrentIndexes` carries design/05 §2.4's `index('…').concurrently(false)` into
the differ, filled by the new exported `nonConcurrentIndexes(schema)`. It travels beside the IR
rather than inside it because `CONCURRENTLY` is a property of how an index is built: `pg_get_indexdef`
has nothing to say about it, so a payload field would differ between the two sides for ever.

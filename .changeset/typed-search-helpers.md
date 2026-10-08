---
'pg-prime': minor
---

Typed helpers for things that previously needed a raw `` sql`…`.as(codec) `` fragment:

- `tsHeadline([config, ]doc, query, options?)` — `ts_headline`, with `HeadlineOptions`
  (`startSel`, `maxWords`, `highlightAll`, …) bound as one option string.
- `similarity`, `wordSimilarity` and `trgmSimilar` (`%`) — pg_trgm on text operands, nullable when
  an operand is.
- `jsonbSet(target, path, value, createMissing?)` — `jsonb_set` with the path as one `text[]` bind and
  the value as `jsonb`; a JS `null` writes the JSON `null`. The result is `unknown` jsonb, so writing
  it back into a `$type<T>()` column takes a cast.
- `tupleGt`, `tupleLt`, `tupleGte`, `tupleLte` — keyset pagination as one row comparison,
  `row(a, b) > row($1, $2)`, each value bound with its column's codec and the arity checked by the
  compiler.

---
'pg-prime': patch
---

- `t.jsonb().nullable().$type<T>()` keeps its `| null` on read, insert and update, the same as `t.jsonb().$type<T>().nullable()`. `unknown | null` collapses to `unknown`, so `.nullable()` on a `jsonb` column now records the null in the column meta, and `$type` and `array` read it from there.
- `.values([...])` with an array throws `.values() takes one row; pass an array of rows to .valuesMany().` instead of `names column(s) [0, 1]`.

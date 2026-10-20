---
'pg-prime': patch
---

- **`char(n)` columns no longer truncate to one character.** `t.raw('char(10)')`, `t.raw('char')` and `t.raw('character(n)')` resolved to the one-byte internal `"char"` codec (OID 18), so every bound value was cut to its first character with no error; `bpcharCodec` also cast as `::char` (= `char(1)`) on the first row of `valuesMany`, in `unnest` bulk inserts and in policy DDL binds. They now resolve to `bpchar` and cast as `::bpchar`. `t.raw()` also understands the other `format_type` spellings (`character varying(n)`, `bit varying(n)`, `double precision`, `timestamp with time zone`, …). Only `t.raw('"char"')` is the one-byte type.
- A relation or `nest()` with more than 50 members executes instead of failing with `54023 cannot pass more than 100 arguments to a function`: the object is built in chunks of 50 — `json_build_object` pieces spliced as text for the default `json` variant (key order, duplicate keys and `\u0000` survive), `jsonb_build_object || …` for `jsonb`.
- An invalid escape in a `sql` template (`'\xZZ'`) is refused with `InvalidFragmentError` naming the hole, instead of silently deleting the rest of the statement.
- A top-level projection key over 63 UTF-8 bytes compiles with a generated alias, like a nested one already did, instead of being rejected as an over-long identifier; the decoded key is unchanged.
- `timestamptz` decoding no longer runs a regex and allocates two `Date`s per cell; same accepted spellings, same values.

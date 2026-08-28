# Northwind (PostgreSQL port)

- Upstream: <https://github.com/pthom/northwind_psql>
- Schema:   <https://raw.githubusercontent.com/pthom/northwind_psql/cd0ef28d66369fbe177778e604e4be0f153c9e5c/northwind.sql>
- Licence:  MIT — <https://raw.githubusercontent.com/pthom/northwind_psql/cd0ef28d66369fbe177778e604e4be0f153c9e5c/LICENSE>
- sha256(schema, upstream):  `0ee30c01ba282f7194f38bf7f99cd6be0470b7ee5f67d0f7ca41fb058d735e0c`
- sha256(LICENSE, upstream): `113e017bde8b63ce79bcdd00609039dab93bb846a561b8d28c999b6c4bd1906c`

Trimmed to schema-only DDL by `tools/corpus-fetch.mjs`: 63 statements kept, 3362 dropped (3362× INSERT INTO).

This file is committed so the corpus is reproducible from a pinned upstream, which is
what makes `01` §11.6 #5 (`verify` green on three real third-party schemas) a gate
rather than an anecdote.

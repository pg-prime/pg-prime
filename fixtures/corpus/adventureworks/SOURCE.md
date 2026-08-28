# AdventureWorks (PostgreSQL port)

- Upstream: <https://github.com/lorint/AdventureWorks-for-Postgres>
- Schema:   <https://raw.githubusercontent.com/lorint/AdventureWorks-for-Postgres/b474991f0df1c4bf55ca4735eb0254ca0709eed2/install.sql>
- Licence:  MIT — <https://raw.githubusercontent.com/lorint/AdventureWorks-for-Postgres/b474991f0df1c4bf55ca4735eb0254ca0709eed2/LICENSE>
- sha256(schema, upstream):  `27f71c99365aa5f44dba5d3b7ca092a654fcf50e6931c4dbe96ba2a13f8b7e0e`
- sha256(LICENSE, upstream): `4eb50d9ccbc26bbdcab24778da282a3fae72f0cd29e773bfc5fa7caae9b0f231`

Trimmed to schema-only DDL by `tools/corpus-fetch.mjs`: 796 statements kept, 2 dropped (1× INSERT INTO, 1× UPDATE PERSON).

This file is committed so the corpus is reproducible from a pinned upstream, which is
what makes `01` §11.6 #5 (`verify` green on three real third-party schemas) a gate
rather than an anecdote.

# Chinook (PostgreSQL)

- Upstream: <https://github.com/lerocha/chinook-database>
- Schema:   <https://raw.githubusercontent.com/lerocha/chinook-database/7f67772503d71ba90f19283c38e93923addb43fa/ChinookDatabase/DataSources/Chinook_PostgreSql.sql>
- Licence:  MIT — <https://raw.githubusercontent.com/lerocha/chinook-database/7f67772503d71ba90f19283c38e93923addb43fa/LICENSE.md>
- sha256(schema, upstream):  `e3fde5c1a5b51a2a91429a702c9ca6e69ba56e6c7f5e112724d70c3d03db695e`
- sha256(LICENSE, upstream): `5064d720db431474b0a0b0cef9d2b5e362b6c6f80602b35c6443b07cbc979f77`

Trimmed to schema-only DDL by `tools/corpus-fetch.mjs`: 33 statements kept, 26 dropped (1× CREATE DATABASE, 1× DROP DATABASE, 24× INSERT INTO).

This file is committed so the corpus is reproducible from a pinned upstream, which is
what makes `01` §11.6 #5 (`verify` green on three real third-party schemas) a gate
rather than an anecdote.

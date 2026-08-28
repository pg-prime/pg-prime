# Pagila

- Upstream: <https://github.com/devrimgunduz/pagila>
- Schema:   <https://raw.githubusercontent.com/devrimgunduz/pagila/pagila-v3.1.0/pagila-schema.sql>
- Licence:  BSD-3-Clause (Sample Database Copyright, see LICENSE) — <https://raw.githubusercontent.com/devrimgunduz/pagila/pagila-v3.1.0/LICENSE.txt>
- sha256(schema, upstream):  `8ce358e4c8014087b85296694a0893887bd7a4190e3ce407f2721b86b98e5707`
- sha256(LICENSE, upstream): `516e7dac679ac1eeb62d5614b01c4e7318154e9a147377d6264954215997ff38`

Trimmed to schema-only DDL by `tools/corpus-fetch.mjs`: 187 statements kept, 46 dropped (1× ALTER SCHEMA, 1× GRANT ALL, 1× REVOKE USAGE, 43× ALTER TABLE).

This file is committed so the corpus is reproducible from a pinned upstream, which is
what makes `01` §11.6 #5 (`verify` green on three real third-party schemas) a gate
rather than an anecdote.

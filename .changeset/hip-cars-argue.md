---
'pg-prime': minor
---

Extension types — `definePgType()`, `citext`, `vector(n)` and pgvector's six distance operators
(design/01 §3 rows 44-`citext`, 61 and 62).

An extension type differs from a built-in in exactly one way: `CREATE EXTENSION` allocates its OID
per database, so no codec may bake the number in. That is the same fact that makes an enum's OID
per-database, and it now takes the same mechanism —
`registry.resolveDynamic(conn, [{ name: 'vector', kind: 'base' }])` reads it out of `pg_type` once
per physical database, pending-codec window included.

- **`definePgType({ name, schema?, encode, decode, typeClass?, arrayOf? })`** builds the codec. A
  third party adds `hstore` or `postgis.geometry` with three lines and no fork. Everything a codec
  needs and the descriptor does not carry is derived: `oid`/`paramOid` are `undefined` until
  resolution, and `jsonEncode` is `'text'` so the value five relations deep is by construction the
  same string `decode` reads at the top level.
- **`t.citext()`** and **`t.vector(n)`** ship as its reference users, in the core package.
  `citext` reads as `string` and gates on every text operator; `vector` reads as `number[]`, and the
  dimension is DDL exactly as `varchar(n)`'s length is. `vector[]` works, and is two vectors rather
  than a two-dimensional array of numbers.
- **`l2` `<->`, `cosine` `<=>`, `innerProduct` `<#>`, `l1` `<+>`, `hamming` `<~>`, `jaccard` `<%>`**
  come off design/03 §2.9's deferred list. All six return `float8`, confirmed against a live
  `RowDescription`; the first four take a `vector` and the last two a `bit`, which is what pgvector
  0.8 declares. `orderBy(asc(cosine(t.embedding, query)))` over an HNSW index is asserted end to end.
- A **typmod is not a type**: a column declared `vector(1536)` — or `t.raw('varchar(50)')`, which
  used to have no codec at all — now resolves to the `vector` and `varchar` codecs.

PGlite has no pgvector and neither do the CI images, so the suites that need it guard on
`PG_PRIME_TEST_VECTOR_URL` and on `pg_available_extensions`, and say what is unverified when they
skip.

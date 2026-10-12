---
'pg-prime': patch
---

A key whose value is `undefined` now counts as absent in every `.values()`, `.valuesMany()` and `.set()`, as the docs say. Before, only a column with a `$default` got that treatment: anywhere else, `undefined` reached the codec and threw `PgEncodeError`, for example `cannot encode a UUID string as uuid (got undefined)` on a nullable uuid. A bulk insert where `undefined` makes the rows set different columns is refused, and the message suggests `null`.

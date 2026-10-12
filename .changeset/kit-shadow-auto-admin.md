---
'@pg-prime/kit': patch
---

`shadow: 'auto'` no longer fails on a role that cannot connect to the `postgres` database. The `CREATEDB` check now reads the privilege on the target, and `auto` demotes to the temp-schema tier when the admin database refuses the connection (`42501`) or does not exist (`3D000`), as it already did on `55006`.

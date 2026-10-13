---
'@pg-prime/kit': patch
---

A foreign key onto a FORCE RLS table now applies when the migration role owns that table and has no `BYPASSRLS`. Before, the FK check failed with `42501` under the runner's `row_security = off`, and `--no-safe-rewrite` did not help. The statement that runs the check (the `VALIDATE`, or a literal `ADD`) is wrapped in a `DO` block that lifts FORCE on the referenced table while the check runs and puts it back, only if the table is forced at apply time. The new warning RL109 reports this, because the referenced table stays `ACCESS EXCLUSIVE` until the migration commits.

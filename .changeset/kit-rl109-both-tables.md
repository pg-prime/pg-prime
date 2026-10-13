---
'@pg-prime/kit': patch
---

- RL109 lifts FORCE from both tables of a foreign key. The check reads the referencing table as well as the referenced one, so 0.2.3 still failed with `42501` when both were forced: it lifted FORCE from one table only, whichever came first.
- A transactional migration that failed and rolled back can now be withdrawn by deleting its file. Before, its `failed` history row made `migrate status` and `migrate doctor` report it as orphaned (exit 4) and made `migrate apply` refuse with `missing_file`. A segmented migration whose earlier segments committed is still reported, since those segments stay in the database.
- History rows and plans record the kit's real version in `engine_version` instead of `0.0.0-spike`.

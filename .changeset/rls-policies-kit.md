---
'@pg-prime/kit': minor
---

**Declared RLS policies and `updated_at` triggers ship through the `sql/` repeatable lane.**

- `migrate generate` renders every `definePolicy(...)` export into `sql/050_policies/<schema>__<table>.sql`,
  every `updatedAtTrigger(...)` into `sql/070_triggers/`, and a `sql/990_declared_prune.sql` that drops
  objects this lane created and no longer declares. Each object carries a
  `COMMENT … IS 'pg-prime:declared sha256:<hash>'` marker, so hand-written objects are never touched.
- `rls.force()` / `rls.enable()` put `FORCE` / `NO FORCE ROW LEVEL SECURITY` in the table's policy file,
  committed with the policies. `FORCE` is not a schema fact, so no fingerprint changes and no re-baseline
  is needed on upgrade.
- The shadow loads the lane from memory, rendered into its own schemas, and never runs the prune: a
  temp-schema generate leaves the target's policies alone.
- Lane hazards are checked before anything is written, against the target's full policy set and the
  shadow's: RL101 (a role loses a command), RL103 (`NO FORCE` on a forced table), RL105 (a restrictive
  policy removed) and RL108 (`FORCE` filters the owner). An unacknowledged one refuses with exit 2;
  `--allow-data-loss --reason` records the acknowledgement in the prune file's header.
  `declared_conflict` (a hand file that writes a declared object or sits at a declared path) and
  `policy_unknown_role` also refuse.
- `migrate apply` re-applies a declared file whose objects are missing, carry another hash or have the
  wrong `FORCE` state, even when its bytes match the recorded checksum.
- `migrate verify` checks the markers and `FORCE` state on the replay (drift, exit 4) and warns on an
  RLS table with no policy. `migrate doctor` reports `declared_missing`, `declared_orphan`,
  `declared_unmarked` and `rls_not_forced`, and says when the prune file may be deleted. `migrate check`
  exits 3 on a stale or conflicting lane.
- `pull` writes RLS flags and policies as `rls.*()` / `definePolicy(...)`, and the runner sets
  `row_security = off`, so a filtered read fails with 42501 instead of returning too few rows.
- New exports: `renderDeclared`, `syncDeclared`, `declaredCensus`, `POLICIES_DIR`, `TRIGGERS_DIR`,
  `PRUNE_FILE`, `LaneRefusedError` and their types; `SchemaLike.policies`.

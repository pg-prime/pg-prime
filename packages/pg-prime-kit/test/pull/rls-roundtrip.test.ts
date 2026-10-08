/**
 * design/20 §8: RLS through `pull` and back, witnessed by the pg_dump oracle with every
 * `pg-prime:declared` marker COMMENT stripped before comparing.
 *
 * Pending the pull side (`rls.*()` and `definePolicy` emitted as DSL, marked `pgprime_set_<col>`
 * triggers as `updatedAtTrigger`); written against the plan until it lands.
 */

import { describe, it } from "vitest";

describe("RLS round trip through pull", () => {
  it.todo(
    "DB A from the §3.3 example → pull → generate + apply into a fresh B: compareDumps(A, B) equal, census green on each",
  );
  it.todo("DB C from a hand-written reference SQL fixture: compareDumps(A, C) equal");
  it.todo("negative control: one changed policy role in C is reported by compareDumps");
});

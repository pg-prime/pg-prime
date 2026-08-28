/**
 * What the repeatables pass will do, decided before anything is executed
 * (design/06 §2.2 Tier R, §3.8, §5.1 step 8).
 *
 * The hash comparison is the entire mechanism: `pgprime.repeatables.checksum` is the sha256 of
 * the bytes that were applied, so a file whose hash still matches has already been executed
 * against this database and re-running it would only cost lock time.
 *
 * `orphaned` is the honest half. `06` §2.2 is explicit that a Tier-R object's REMOVAL is not
 * auto-detected: deleting `sql/030_views/active_users.sql` leaves the view in the database and
 * nothing in the plan will ever drop it. Rather than pretend otherwise, the recorded paths
 * that no longer exist on disk are reported so `doctor` can name them.
 */

import type { AppliedRepeatable, RepeatableClient } from "./apply.js";
import { applyRepeatables } from "./apply.js";
import type { RepeatableFile, ScanOptions } from "./scan.js";
import { scanRepeatables } from "./scan.js";

export interface RepeatablesPlan {
  /** New or hash-changed, in scan order — which is apply order. */
  readonly toApply: readonly RepeatableFile[];
  readonly unchanged: readonly RepeatableFile[];
  /** Recorded as applied, no longer on disk. Sorted. */
  readonly orphaned: readonly string[];
}

export async function planRepeatables(
  dir: string,
  applied: ReadonlyMap<string, string>,
  options?: ScanOptions,
): Promise<RepeatablesPlan> {
  const files = await scanRepeatables(dir, options);
  const toApply: RepeatableFile[] = [];
  const unchanged: RepeatableFile[] = [];
  const onDisk = new Set<string>();

  for (const file of files) {
    onDisk.add(file.path);
    // Unknown path or different hash — both are "apply it". Comparing the stored hash rather
    // than an mtime is what makes a `git checkout` of an older revision re-apply the file.
    if (applied.get(file.path) === file.sha256) unchanged.push(file);
    else toApply.push(file);
  }

  // Sorted so a `doctor` report is stable across runs and reviewable as a diff.
  const orphaned = [...applied.keys()].filter((path) => !onDisk.has(path)).sort();
  return { toApply, unchanged, orphaned };
}

/**
 * The two calls the runner makes, as a type.
 *
 * The runner (`06` §5.1 step 8) depends on this interface rather than on the functions, so the
 * apply loop can be unit-tested against a fake pass without a filesystem or a server.
 */
export interface RepeatablesPass {
  plan(dir: string, applied: ReadonlyMap<string, string>): Promise<RepeatablesPlan>;
  apply(client: RepeatableClient, toApply: readonly RepeatableFile[]): Promise<AppliedRepeatable[]>;
}

export function createRepeatablesPass(options?: ScanOptions): RepeatablesPass {
  return {
    plan: (dir, applied) => planRepeatables(dir, applied, options),
    apply: (client, toApply) => applyRepeatables(client, toApply),
  };
}

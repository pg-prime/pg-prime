/**
 * design/06 §6.1's exit codes — "uniform across every command".
 *
 * One table, imported by the runner and by every command, so a code cannot be spelled as
 * a number in two places and drift. It lives under `cli/` because it is the CLI's
 * contract with an orchestrator; the runner imports it rather than inventing a parallel
 * enum, which is what "uniform" has to mean if it is to mean anything.
 */
export const EXIT = {
  /** Success, or nothing to do. */
  ok: 0,
  /** Bad config, connection failure, SQL error, internal. */
  error: 1,
  /** An unresolved rename or unacknowledged data loss needs a human decision. */
  missingHints: 2,
  /** Lint failure at `error` severity. */
  lint: 3,
  /** Non-empty diff, fingerprint mismatch, or checksum drift. */
  drift: 4,
  /** Pending migrations exist (the CI gate). */
  pending: 5,
  /** Lock unavailable — a concurrent deploy holds it. */
  locked: 6,
  /** The plan does not converge on a clone. */
  proof: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Every terminal state `applyPending` can report, and the code it exits with. */
export type RunnerStatus =
  | "applied"
  | "up_to_date"
  | "dry_run"
  | "drift"
  | "locked"
  | "failed"
  | "refused";

export const RUNNER_EXIT: Readonly<Record<RunnerStatus, ExitCode>> = {
  applied: EXIT.ok,
  up_to_date: EXIT.ok,
  dry_run: EXIT.ok,
  drift: EXIT.drift,
  locked: EXIT.locked,
  failed: EXIT.error,
  // A transaction-mode pooler is a connection that cannot hold a session lock at all.
  // design/06 §0's gate for this workstream says exit 1 and design/06 §6.2 lists
  // `apply` as 0 · 1 · 4 · 6 — a refusal to start is the `1` of that list, not the `6`:
  // nothing holds the lock, the connection is simply unusable. See the AS BUILT note
  // under design/06 §5.2.
  refused: EXIT.error,
};

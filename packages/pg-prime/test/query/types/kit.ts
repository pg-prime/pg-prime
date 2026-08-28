/**
 * Shared assertion helpers for the WS1 type probes.
 *
 * `expectTypeOf` (R7a) is the readable positive; `Assert<Eq<A, B>>` is the same check written so
 * it *cannot* be skipped — it is a type alias, so it is evaluated even in a file the runner never
 * executes, and it fails as TS2344 rather than as a silently-ignored expression statement.
 *
 * `Eq` is the strict identity test (a conditional-type identity trick, not mutual assignability),
 * so `{ a: string }` and `{ a: string | never }` compare equal while `{ a?: string }` and
 * `{ a: string | undefined }` do not. That distinction is load-bearing here: `$if`'s boolean
 * overload must produce an *optional* key, not a `| undefined` one.
 */
export type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
export type Assert<T extends true> = T

// design/08 §2.4 step 4 — the `sideEffects: false` correctness fixture.
//
// Import the package, use nothing. If any module in `pg-prime` did something observable at import
// time — registered a global, wrote to a shared registry, read an environment variable eagerly —
// a correct bundler would have to keep it, and this bundle would not be empty. The budget is
// < 200 bytes, which is "gzip of nothing at all" plus slack.
import 'pg-prime'

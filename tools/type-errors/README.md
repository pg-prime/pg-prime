# `tools/type-errors` — diagnostic goldens

design/04 §4 makes a measurable claim about error ergonomics: on three identical mistakes we print
**3 lines / 641 characters** against kysely@0.29.5's 10 / 1 402 and drizzle-orm@0.45.2's 14 / 3 226.
A claim like that decays silently — one extra overload, one long inferred type in a constraint, and
the number doubles with nothing failing.

So each file in `cases/` is one mistake, and `__golden__/<case>.<ts-version>.txt` is the exact
`tsc --pretty false` output it produces. `packages/pgorm/test/query/type-errors.test.ts` compiles
the whole directory on **both** compilers (5.9.3, the consumer floor, and 7.0.2, the build compiler)
and diffs against the golden.

Two things the test enforces beyond the diff:

- every case produces **at least one** diagnostic (a case that stops failing is a lost guard, not a
  passing test);
- the D9 budget — one line, under 300 characters — is measured per case and printed. Cases that
  exceed it are listed explicitly in the test rather than quietly tolerated.

Regenerate after an intentional change:

    node tools/type-errors/record.mjs

and review the diff as you would review the sentence itself, because that is what it is: these
strings are public API.

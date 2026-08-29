# Why `@prisma/client` is not an arm of the comparison run

`08` §5 names three competitors for the nightly comparison — `drizzle-orm`, `kysely` and
`@prisma/client` — and design/12 §4 P qualifies the third: include it "only if its generate/engine
step fits in the nightly budget — record either way". This is the record.

**It is not included.** The generate step turned out to be a red herring; the *install* is the
problem, and the reason it is decisive is that it is not the comparison job's install alone.

## Measured, 2026-08-29, prisma 7.10.0 / @prisma/client 7.10.0

| | measured |
|---|---|
| `pnpm add prisma @prisma/client` into an empty project, cold store | **8 min 44 s** |
| the resulting `node_modules` | **296 MB** |
| `prisma@7.10.0` unpacked, from the registry | 42.0 MB |
| `@prisma/client@7.10.0` unpacked, from the registry | 74.5 MB |
| `prisma generate` for a three-field model | **0.87 s wall, 37 ms of generation** |
| the same install through `npm`, which resolves `prisma@latest` = 8.0.0-rc.12 | 21 min, **1.0 GB** |

The last row is corroboration rather than the measurement — `npm` resolved a release candidate
with a different CLI (`generate` is not a registered command in 8.0.0-rc.12) — but the shape is
the same and the magnitude is worse. This repository uses pnpm, so the pnpm row is the one that
decides.

`prisma generate` is *fast* — fast enough that the concern design/12 raised about it does not
survive contact with the number. Two other things do.

## 1. The install is not scoped to this workspace

Every job in `ci.yml` and `ci-nightly.yml` begins with `pnpm install --frozen-lockfile` at the
repository root, which resolves and links **every** workspace package's dependencies. pnpm has no
notion of "install only what this job's workspace needs" without changing that command everywhere,
so a devDependency added to `bench/compare` is paid by the tier-2 matrix (four jobs), the 1M fuzz
job, the type budgets, and every one of `ci.yml`'s per-PR jobs. That is the whole reason
`bench/compare` is a separate workspace in the first place; a 296 MB dependency defeats the
separation from the other side.

The fallback, if the arm is ever wanted, is to give every job a `--filter` on its install. That is
a change to two workflow files owned by other workstreams and a new way for a job to fail
mysteriously (a filtered install that misses a transitive dev dependency fails at `import`, not at
`install`), so it is recorded here rather than done.

## 2. It would need a fifth spelling of the fixture, checked by nothing

The comparison runs against `packages/pg-prime/test/live/fixture.ts` — the one table set in this
repository whose declarations are asserted against `information_schema` (R5,
`fixture.drift.test.ts`). raw `pg` needs no schema, kysely's is types-only, and drizzle's is
`schema.mjs` beside this file, which the answer check keeps honest: every arm's rows are compared
with pg-prime's before anything is timed, so a drizzle column that drifted would fail the run.

Prisma's schema is not JavaScript. It is a `schema.prisma` in Prisma's own language, consumed by a
generator, and nothing in this repository can compare it with the fixture. The answer check would
still catch a drifted *column*, but a `schema.prisma` is also where the datasource, the client
options and the model-to-table mapping live, and none of that is reachable from a test.

Prisma 7 sharpens this: `datasource { url }` is refused outright — measured, `P1012`, "the
datasource property `url` is no longer supported in schema files" — and a direct connection now
needs a `prisma.config.ts` plus `@prisma/adapter-pg` passed to the `PrismaClient` constructor. So
the arm is a `.prisma` file, a `.config.ts` file, a third package, and a generate step whose output
lands in `node_modules` and therefore has to be reproduced inside every job that runs the bench.

## What we lose, and what stands in its place

`08` §5's anti-target is Prisma's **~11× average / ~27× p99**, and that figure comes from round-1's
research with its source and its date; it is not a number this bench was ever going to improve on
by re-measuring. What the comparison run does measure — pg-prime against the two libraries a reader
is actually choosing between, on identical queries, through one shared `pg.Pool`, with every answer
checked — is the part that was missing.

If this decision is revisited, the two things to re-measure are the install cost on a runner with a
warm pnpm store and whether a `--filter`ed install is workable across both workflow files. Neither
was worth doing to add a fourth column.

# `@pg-prime/docs` — the documentation site

Astro 7 + Starlight 0.41, with Pagefind search. Private; never published to npm. Content is
CC-BY-4.0 (design/08 §6.5); the site's own code is MPL-2.0 like the rest of the repo.

```sh
pnpm docs:dev        # local server on :4321
pnpm docs:build      # the pooler matrix generator, then `astro build` (Pagefind runs here)
pnpm docs:typecheck  # every fenced ts/tsx block compiles on TypeScript 5.9.3
pnpm docs:examples   # every `title=` block runs against PGlite
pnpm docs:coverage   # every exported name has a reference entry; CLI + hazard tables are current
pnpm docs:check      # all four, in that order — what CI's `docs` job runs
```

`pnpm build` (the packages) must have run first: all three gates resolve `pg-prime` and
`@pg-prime/kit` through `docs/node_modules`, which pnpm links at `packages/*`, whose `exports` maps
point at `dist`. The docs therefore describe the **built** packages, not the sources.

## The one rule

**Every fenced `ts`/`tsx` block on this site compiles, and every one with a `title=` runs**
(design/12 §2 R20). There is no "illustrative pseudo-code" register here: if a block cannot be
made to compile, it is either wrong or it is not TypeScript, and both have answers below.

## Block directives

Directives go in an MDX comment on the line **immediately above** the fence. `title=` is the one
exception: it lives on the fence, because Expressive Code renders it as the file-name tab.

````mdx
{/* docs: use=blog */}
```ts title="publish-a-post.ts"
await db.update(db.h.posts).set({ published: true }).where((p) => eq(p.posts.id, 1n)).execute()
```
````

| Directive | Effect |
|---|---|
| `title="file.ts"` (on the fence) | The block is an **example**: `docs-examples.mjs` executes it against PGlite. Give every runnable block a name that reads like a file. |
| `use=name[,name2]` | "This code is in scope." `name` is a file in `docs/src/snippets/` or a `setup=` block on the same page. Two shapes, below. |
| `setup=id` | Register this (visible) block as a prelude that other blocks on the page can `use=`. |
| `signature` | The block is a declaration, not a program: it is compiled inside `declare namespace` with every type of the page's `apiEntry` in scope. This is how reference signatures are checked. Bodiless functions, bare `interface`s and `type` aliases belong here. |
| `expect-error` | The block **must** fail to compile. Used where a page claims something is refused; if it starts compiling, the gate fails. |
| `no-run` | A `title=` block that is a file rather than a program — a `pg-prime.config.ts`, a migration, a snippet of somebody else's library. Still compiled. |
| `skip-check="reason"` | Not compiled. The reason is mandatory and is printed by the gate on every run. Use it only for code in another language's TypeScript (a Drizzle or Prisma snippet on a comparison page). |
| `cli="migrate generate --help"` | The block must be, verbatim, what the built binary prints. `node tools/docs-coverage.mjs --write` regenerates it. |

Languages other than `ts`/`tsx` are never compiled or executed: `sh` blocks are CLI walkthroughs,
`sql` blocks are output, `json` blocks are files.

### The two shapes of `use=`

- **A file.** A `setup=` block that also has a plain-file `title` (`title="schema.ts"`) is written
  as *that file* next to the block using it, and the block imports it exactly as a reader's project
  would: `import { schema } from './schema.js'` resolves to `schema.ts`, which is what NodeNext does
  and what the examples runner's bundler does. This is how a multi-file walkthrough stays honest.
- **A prelude.** A snippet, or a `setup=` block with no file name, is prepended textually, so an
  invisible prelude's `const db = …` is simply in scope with nothing on the page to explain.

Either way no line of the block is rewritten, and diagnostics point back at the page.

The three snippets, and what each is for:

| Snippet | Contents | Typical use |
|---|---|---|
| `blog-schema` | `users` + `posts`, both relations, `defineSchema` | a block that only needs the types |
| `blog` | `blog-schema`, plus a `db` built from `DATABASE_URL` | `use=blog` |
| `blog-ddl` | the two `create table` statements, run through `db.sql` | `use=blog,blog-ddl` — needed by any block that reads or writes rows |

## Runnable examples

`tools/docs-examples.mjs` starts one PGlite behind the repo's own wire-protocol bridge
(`packages/pg-prime/test/live/_pglite.ts`) and puts its URL in `DATABASE_URL`. An example connects
the way an application does:

```ts
const db = pgPrime({ connection: process.env['DATABASE_URL']!, schema })
```

so nothing is rewritten. A block that hard-codes a `'postgres://…'` literal is still run, with that
**one line** substituted and reported in the gate's output.

Each example is a separate process and gets a clean database (`drop schema public cascade` between
runs), so examples never depend on each other. An example that hangs is killed after 60 s and fails.

Most examples begin `use=blog,blog-ddl`: two tables, a relation in each direction, a `db`, and the
DDL that makes the queries real.

## Reference pages

A reference page declares which entry point it documents:

```yaml
---
title: pg-prime/schema
apiEntry:
  - pg-prime#./schema
  - pg-prime#.
---
```

`tools/docs-coverage.mjs` then enforces both directions against `tools/api-snapshot/*.json`:

- every exported name of that entry must have an **anchor** on some page that claims it — either a
  `### \`name\`` heading or an `<a id="name"/>` tag (families of small types are documented as a
  table of anchored rows, which is what "briefly grouped" means);
- every anchor on the page must be a name the goldens contain, so a rename or a removal fails here.

A page may claim two entries (the root re-exports the subpaths), and one anchor then covers the name
in both.

`docs/.gen/scaffold.mjs` prints every name's kind, `.d.ts` signature and JSDoc
(`node docs/.gen/scaffold.mjs pg-prime/sql`); it is raw material for a human, not a generator —
design/08 §6.4 chose hand-written pages over TypeDoc on purpose.

## Generated regions

`tools/pooler-matrix.mjs` rewrites the region between the `GENERATED:pooler-matrix` markers on
`operations/poolers.mdx` from the built `POOLER_PROFILES` (design/12 decision 6). It runs as the
first step of `docs:build` and `docs:dev`, so the published page cannot be stale; `--check` fails if
the committed page has drifted.

The CLI reference's `--help` blocks and the hazard-code table are checked, not generated in place:
`docs:coverage` compares them with the binary and with the kit's own tables, and
`node tools/docs-coverage.mjs --write` refreshes the CLI blocks.

## Deploying (operator steps)

`.github/workflows/docs.yml` publishes `docs/dist` to GitHub Pages on every push to `main`. It
cannot work until an operator turns Pages on **once**:

1. GitHub → the repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Nothing else. The workflow already requests `pages: write` and `id-token: write`.

Until then the deploy step fails with `Get Pages site failed`; the `docs` job in `ci.yml` (which
builds the site and runs the three gates) is unaffected, so a broken page still fails a PR.

The site is served from `https://<org>.github.io/pg-prime/`, which is why `astro.config.mjs` sets
`base: '/pg-prime'`. For a custom domain, set `PG_PRIME_DOCS_SITE` and `PG_PRIME_DOCS_BASE=/`.

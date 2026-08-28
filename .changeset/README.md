# Changesets

Every pull request that changes anything under `packages/` needs a changeset. `ci.yml`'s `lint`
job enforces it with `changeset status --since=origin/main`, and CI is where you will find out if
you forgot — so run `pnpm changeset` before you push.

```
pnpm changeset            # write one, interactively
pnpm changeset status     # what would be released, and at which bump
```

Three rules that are ours rather than the tool's, all from `design/08-architecture.md` §6:

- **`pg-prime` and `@pg-prime/kit` are a `fixed` group** (§1.1). They always publish the same
  version, because version skew between an ORM and its CLI is a permanent support tax. Bumping
  either one bumps both; write the changeset for whichever package actually changed and let the
  tool do the rest. `@pg-prime/testing` and `@pg-prime/create` version independently.
- **Breaking changes land in a MINOR (`0.N.0`) while we are pre-1.0, never in a PATCH** (§6.1).
  So a breaking change is `minor`, and the changeset body carries a `BREAKING:` section, a
  before/after entry for `MIGRATING.md`, and — wherever the change is mechanical — a codemod.
  A breaking change with no migration path does not merge.
- **The summary is a changelog entry, not a commit message.** It is read by someone deciding
  whether to upgrade. Say what changed for *them*.

Releasing is `RELEASING.md`; nothing in this directory publishes anything.

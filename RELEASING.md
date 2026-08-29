# Releasing

The operator runbook. `design/08-architecture.md` §6 is the policy this implements; this file is
the sequence of things a human does, and the short list of things a human must do **by hand**
because npm does not let a workflow do them.

Nothing in this repository publishes anything until the one-time setup in §1 is done, on purpose.

---

## 0. The shape of it

| | |
|---|---|
| Version tool | Changesets (`@changesets/cli@3`), config in `.changeset/config.json` |
| Version group | **`pg-prime` and `@pg-prime/kit` are `fixed`** — always the same version |
| Independent | `@pg-prime/testing`, `@pg-prime/create` |
| Publisher | `.github/workflows/release.yml`, on push to `main` |
| Auth | **npm trusted publishing (OIDC).** There is no npm token anywhere |
| Provenance | `NPM_CONFIG_PROVENANCE: true`, so every tarball carries an attestation |
| Pre-1.0 rule | breaking changes land in a MINOR (`0.N.0`), never a PATCH |

A release is **a merge**, not a command. You never run `npm publish`, and after §1 nobody can:
there is no credential to run it with.

---

## 1. One-time setup, per package, by a human on npmjs.com

npm requires the **first** publish of a name to be manual, and a trusted publisher can only be
configured on a package that exists. So for each of `pg-prime`, `@pg-prime/kit`,
`@pg-prime/testing` and `@pg-prime/create`, in this order:

1. **Publish `0.0.0` by hand**, once, from a laptop, with 2FA:

   ```sh
   pnpm --filter <package> build
   cd packages/<dir> && npm publish --access public
   ```

   (The four placeholder `0.0.0`s are already published — see §5. If a name is already on the
   registry under our account, skip to step 2.)

2. **Configure the trusted publisher.** npmjs.com → the package → *Settings* → *Trusted publisher*
   → **GitHub Actions**, and enter exactly:

   | Field | Value |
   |---|---|
   | Organization or user | `pg-prime` |
   | Repository | `pg-prime` |
   | Workflow filename | `release.yml` |
   | Environment | *(leave empty)* |

   The workflow filename is matched literally. Renaming `release.yml` breaks publishing for every
   package until each one's trusted publisher is edited — so do not rename it.

3. **Turn the token off.** Same page: set *Publishing access* to **"Require two-factor
   authentication or an automation token"** → then, once trusted publishing works, remove any
   automation token that exists for the package and delete it from the npm account. The design
   goal is that no long-lived credential can publish `pg-prime`; leaving one behind defeats it.

4. **Check `provenance`.** `packages/*/package.json` already carries
   `"publishConfig": { "access": "public", "provenance": true }`. Nothing to do — this is here so
   that a new package added later is not published without it.

**Tooling floor.** Trusted publishing needs npm ≥ 11.5.1 or pnpm ≥ 10.17. The workflow pins pnpm
through the root `packageManager` field (10.33.0) and Node 24, both of which are above it.

**One gotcha, if you ever run `pnpm changeset version` on your laptop.** The changelog generator is
`@changesets/changelog-github`, which calls the GitHub API to attribute each entry, so it needs a
`GITHUB_TOKEN` in the environment (`read:user`, `repo:status`) and fails with a link to the token
page without one. In CI this is `secrets.GITHUB_TOKEN`, already wired on the `changesets/action`
step. You should not normally need to run `version` by hand at all — that is what the "Version
Packages" PR is.

---

## 1b. One-time setup for the documentation site (also a human, also once)

`.github/workflows/docs.yml` publishes `docs/dist` to GitHub Pages on every push to `main`, and it
cannot work until Pages is switched on for the repository:

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

That is the whole step. The workflow already requests `pages: write` and `id-token: write`, which is
what `actions/deploy-pages` needs; until the setting is flipped, its `deploy` job fails with
`Get Pages site failed` on `main`. Nothing else in CI depends on it — `ci.yml`'s `docs` job builds
the site and runs the three content gates on every pull request either way — so the failure is loud
and harmless. The site is served from `https://pg-prime.github.io/pg-prime/`; for a custom domain,
set `PG_PRIME_DOCS_SITE` and `PG_PRIME_DOCS_BASE=/` in the workflow's environment and add the CNAME
in the same settings page.

## 2. Who may release

Design/08 §6.2 criterion #11 requires **at least two people** with publish rights and repo admin,
and requires the *second* person to have executed this runbook end to end at least once.

With trusted publishing "publish rights" is two things, not one:

- **npm:** owner/maintainer on the four packages, so they can edit the trusted-publisher settings
  and do a first manual publish. This is the only npm privilege anyone needs.
- **GitHub:** the ability to merge the "Version Packages" PR into `main`. That is what actually
  triggers a publish, so it is the more consequential of the two. `main` must stay protected.

Adding a third releaser is a permissions change on two web UIs. It is never a secret hand-off,
because there is no secret.

---

## 3. How a release flows

```
 feature PR  ──▶  `pnpm changeset` in the PR  ──▶  merge to main
                                                        │
                        release.yml sees .changeset/*.md │
                                                        ▼
                              "chore(release): version packages" PR
                              (versions bumped, CHANGELOG.md written,
                               changeset files consumed)
                                                        │
                                     a human merges it   │
                                                        ▼
                        release.yml sees no changesets → pnpm build
                                                       → pnpm package:check
                                                       → pnpm changeset publish
                                                       → git tags pushed
```

**As a contributor.** Add a changeset in the PR that changes a package:

```sh
pnpm changeset          # pick the packages, pick the bump, write the entry
```

`ci.yml`'s `lint` job runs `changeset status --since=origin/main` on any PR that touches
`packages/` and fails without one. `.changeset/README.md` has the rules for writing them.

**As the releaser.** Read the "Version Packages" PR before merging it:

- Are the version numbers what you expect? `pg-prime` and `@pg-prime/kit` must be **identical** —
  if they are not, the `fixed` group in `.changeset/config.json` has been broken.
- Does each `CHANGELOG.md` entry read like something a user can act on?
- Is anything breaking? Then it must be a **minor** (we are pre-1.0), and `MIGRATING.md` must have
  the before/after entry, and a codemod must exist wherever the change is mechanical.
- Is `main` green?

Then merge it. The same workflow run publishes and pushes the tags. Cut the GitHub Releases from
the generated changelogs.

---

## 4. Dry-running the whole path

Before the first real release, and any time `release.yml` or `package:check` changes:

*Actions → release → Run workflow → `dry_run` ✅ (the default) → Run.*

That runs the identical steps — `pnpm install --frozen-lockfile`, `pnpm build`,
`pnpm package:check`, then `pnpm publish -r --dry-run --no-git-checks` — and publishes nothing.
It also proves the OIDC assertion is reachable, because the job refuses to start without it.

`dry_run: false` is deliberately **not** a way to publish: the job fails with a sentence pointing
back here. A release is a merge.

Locally, the same checks minus the registry:

```sh
pnpm install --frozen-lockfile && pnpm build && pnpm package:check
pnpm publish -r --dry-run --no-git-checks
```

---

## 5. Deprecating `pgormjs@0.0.0`

`pgormjs` is the pre-rename placeholder (design/08 §1.3). Once `pg-prime@0.x` is on the registry,
deprecate it — do not unpublish it, because unpublishing breaks anyone who already resolved it:

```sh
npm deprecate pgormjs@'*' 'Renamed to pg-prime. Install pg-prime (and @pg-prime/kit for the CLI).'
```

Then, on npmjs.com, remove any automation token scoped to `pgormjs` and leave the package
otherwise untouched. The same treatment applies to any other placeholder we abandon.

---

## 6. When it goes wrong

**`changeset publish` fails with an auth error on one package.** That package has no trusted
publisher configured, or its workflow filename does not match. Redo §1 step 2 for it. The other
packages in the run have already published; re-running the workflow publishes only what is
missing, because `changeset publish` skips versions the registry already has.

**The "Version Packages" PR keeps reopening.** It is force-updated on every push to `main` that
carries changesets. That is normal. Merge it when you want to release.

**`pg-prime` and `@pg-prime/kit` came out at different versions.** Stop. The `fixed` group is what
prevents this and something has edited it. Do not paper over it with a manual publish; fix the
config and cut a new version of both.

**A bad version shipped.** Publish a fix as a new version. Do **not** `npm unpublish`, and do not
`npm dist-tag` a lower version back to `latest` — deprecate the bad one instead:

```sh
npm deprecate pg-prime@0.4.2 "Broken: <one sentence>. Use 0.4.3."
```

**Someone asks for an emergency manual publish.** There is no credential for it, by design. The
path is: fix, merge, merge the version PR. If `main` is broken badly enough that this is
impossible, the fix is to unbreak `main`.

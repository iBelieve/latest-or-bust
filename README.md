# latest-or-bust

Fail CI when a change adds or changes an npm dependency that isn't on its latest version.

Dependabot and Renovate keep the dependencies you already have up to date. They don't stop a pull
request from adding a new dependency at an old version, or from upgrading one only part of the way
(say from 1.0.0 to 1.1.0 when 1.2.0 is out). latest-or-bust does: it finds every dependency a change
adds, or changes the version of, and fails if any of them isn't the newest release. Dependencies the
change leaves alone aren't checked, so it never fails a pull request for something it didn't touch.

It's built on [npm-check-updates](https://github.com/raineorshine/npm-check-updates), which does
the work of finding each dependency's newest release: latest-or-bust works out what a change touched
and asks npm-check-updates about just those.

```console
$ npx latest-or-bust
Checking dependencies added or changed since 3c23f15…
package.json: hono, react
packages/web/package.json: vite

Not the newest release:
  package.json  react  ^19.3.1 → ^19.3.2
  packages/web/package.json  vite  7.4.0 → 7.5.1

Update them, or if one is held back on purpose, exempt it in latest-or-bust.json with the reason why.
```

## Usage

```sh
npm install --save-dev latest-or-bust   # or pnpm add, yarn add, bun add
npx latest-or-bust [base revision]
```

It compares the working tree with the base revision, which defaults to where `HEAD` branched from
`origin`'s default branch (`origin/HEAD`, else `origin/main` or `origin/master`). It exits with 1 if
a dependency added or changed since then isn't the newest release, and 0 otherwise.

### In GitHub Actions

Run it with no arguments in a workflow that runs on pull requests, and it works out what to compare
with on its own:

```yaml
on: [push, pull_request]

jobs:
  dependencies:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - run: npx latest-or-bust
```

- On a `pull_request` run, it compares with the pull request's base. `actions/checkout` checks out
  the merge of the pull request into its base, so that's the merge's first parent; in a shallow
  clone (the default), latest-or-bust fetches that one commit. In a private repository checked out
  with `persist-credentials: false`, that fetch has no credentials, so check out with
  `fetch-depth: 2` instead. If you check out the pull request's
  own head instead, it compares with where that branched from the base, which needs the history
  (`fetch-depth: 0`).
- Any other run, such as a push to the default branch, a schedule or a merge queue, passes with a
  note that there's nothing to check: there's no change to compare, and the pull request was
  checked when it was open. So the same workflow can run on pushes and pull requests.
- Pull requests from Dependabot and Renovate pass too. Their grouped minor-and-patch pull requests
  don't move a dependency to a new major version even when one is out, so they'd fail the check for
  doing what they're set up to do.
- So does a pull request that promotes `develop` into `main` or `master`, as in a git-flow release.
  Its dependencies were checked by the pull requests that brought them into `develop`, and newer
  releases may have come out since, so checking them again would fail a release for nothing it
  changed. Only a branch in the repository itself counts, not a fork's. List your own branches as
  `promotions` in `latest-or-bust.json`, which replaces the default (`[]` checks every pull
  request):

  ```json
  { "promotions": [{ "from": "next", "into": "main" }] }
  ```

Pass a base revision to skip all of this and compare with it (`npx latest-or-bust origin/main`).
Outside GitHub Actions, it always compares with the base revision, or where `HEAD` branched from
`origin`.

## What it checks

- The root `package.json` and every workspace package's: the `packages` in `pnpm-workspace.yaml`,
  and the `workspaces` in the root `package.json` that npm, Yarn and Bun use (globs and `!`
  exclusions included). Other `package.json` files, such as test fixtures, are left out.
- In each, `dependencies`, `devDependencies` and `optionalDependencies`, each on its own, so a
  dependency in more than one is checked in each (and the report names the section).
  `peerDependencies` are left out, since they're deliberately wide ranges rather than what gets
  installed.
- Catalogs, default and named: pnpm's in `pnpm-workspace.yaml`, Yarn's in `.yarnrc.yml`, and Bun's
  in the root `package.json` (at the top level or in `workspaces`).

A dependency counts as changed when its version spec changes at all, so a range whose floor isn't the
newest release fails too (`^1.1.0` when 1.2.0 is out). A dependency moved to another section with
the same spec hasn't changed. Specs that don't name a registry version
(`workspace:`, `catalog:`, `file:`, `link:`, `npm:` aliases, git URLs) are skipped; a catalog's
entries are checked in the catalog.

The newest release comes from [npm-check-updates](https://github.com/raineorshine/npm-check-updates),
which reads your registry settings from `.npmrc` (and in a Yarn project, the `npmScopes` in
`.yarnrc.yml`), and honors the package manager's release-age cooldown, so it never asks for a
release your package manager won't install yet:

- npm: `min-release-age` in `.npmrc`
- pnpm: `minimumReleaseAge` in `pnpm-workspace.yaml`, `PNPM_CONFIG_MINIMUM_RELEASE_AGE` or pnpm's
  global config. pnpm 11 and later wait a day when nothing sets it, and so does latest-or-bust,
  leaving out what `minimumReleaseAgeExclude` names. pnpm's version comes from `packageManager` in
  `package.json`, else `pnpm --version`.
- Yarn: `npmMinimalAgeGate` in the root `.yarnrc.yml`, or in your home directory, leaving out what
  `npmPreapprovedPackages` names (Yarn 4.10 and later; Yarn 1 has none)
- Bun: `minimumReleaseAge` and `minimumReleaseAgeExcludes` in `bunfig.toml`'s `[install]`, or in
  the global `.bunfig.toml` (in `$XDG_CONFIG_HOME`, else your home directory)

A dependency it can't look up, because it isn't on the registry or the registry is unreachable or
refuses the login, fails the check too: there's no telling whether it's the newest.

latest-or-bust doesn't read npm-check-updates' own config files (`.ncurc` and the like), so the
options there can't change what it checks.

## Holding a dependency back

To keep a dependency on an older version on purpose, exempt it in `latest-or-bust.json` at the
repository root, with the reason why. Every exemption needs a reason, and applies in every package
and catalog:

```json
{
  "$schema": "./node_modules/latest-or-bust/schema.json",
  "exempt": {
    "@types/foo": {
      "reason": "Only covers foo 1.x, and foo 2 ships no types of its own",
      "allow": "minor"
    },
    "bar": { "reason": "bar 3 drops Node.js 22" }
  }
}
```

- `"allow": "minor"`: the dependency may stay on its current major version, but must be the newest
  release there. If you add `@types/foo` at `^1.4.0` when 1.5.0 and 2.0.0 are out, it fails, asking
  for `^1.5.0`.
- No `allow`: the dependency isn't checked at all.

Exempt dependencies are listed in the output with their reasons. Take an exemption off once its
reason is gone.

## Package managers

npm, pnpm, Yarn (1 and 2 and later) and Bun are supported. The package manager is the one the root
`package.json`'s `packageManager` names, else the one whose lockfile is at the root
(`pnpm-lock.yaml`, `yarn.lock`, `bun.lock` or `bun.lockb`, `package-lock.json` or
`npm-shrinkwrap.json`), else the one whose config file is (`pnpm-workspace.yaml`, `.yarnrc.yml`,
or a `bunfig.toml` with an `[install]` table: one without configures only Bun's runtime or test
runner), else npm.

Registry settings that only Yarn 2+ or Bun read (`.yarnrc.yml`'s top-level `npmRegistryServer` and
`npmAuthToken`, `bunfig.toml`'s registries) aren't used: a dependency from such a registry fails as
one it can't look up. Put the registry in `.npmrc` too (Bun reads it as well), or for Yarn, in
`npmScopes` (which are only read with `yarn.lock` at the root).

## Requirements

Node.js 22.22.2 or later on the 22 line, 24.15.0 or later on the 24 line, or 26 and later; and git.

## Development

`pnpm install`, then `pnpm run typecheck`, `pnpm run lint`, `pnpm run fallow` (dead code and
duplication), `pnpm test` (including fast-check property tests), `pnpm run test:coverage` and
`pnpm run health` (complexity and CRAP scores), `pnpm run mutation --base origin/master` (mutation
testing of what a branch changes), `pnpm run smoke` (the packed package, against the real registry)
and `pnpm run format:check`. CI runs all of them; `CLAUDE.md` says what each one checks.

## Acknowledgments

latest-or-bust depends on [npm-check-updates](https://github.com/raineorshine/npm-check-updates),
created by Tomas Junnonen and maintained by [Raine Revere](https://github.com/raineorshine) and its
contributors, under the Apache License 2.0. If latest-or-bust is useful to you, so is
npm-check-updates on its own: `ncu -u` upgrades all of a `package.json`'s dependencies at once, and
`ncu -u --workspaces` every workspace package's too.

## License

MIT

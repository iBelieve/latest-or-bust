# latest-or-bust

Fail CI when a change adds or changes an npm dependency that isn't on its latest version.

Dependabot and Renovate keep the dependencies you already have up to date. They don't stop a pull
request from adding a new dependency at an old version, or from upgrading one only part of the way
(say from 1.0.0 to 1.1.0 when 1.2.0 is out). latest-or-bust does: it finds every dependency a change
adds, or changes the version of, and fails if any of them isn't the newest release. Dependencies the
change leaves alone aren't checked, so it never fails a pull request for something it didn't touch.

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
npm install --save-dev latest-or-bust   # or: pnpm add --save-dev latest-or-bust
npx latest-or-bust [base revision]
```

It compares the working tree with the base revision, which defaults to where `HEAD` branched from
`origin`'s default branch (`origin/HEAD`, else `origin/main` or `origin/master`). It exits with 1 if
a dependency added or changed since then isn't the newest release, and 0 otherwise.

### In GitHub Actions

On a `pull_request` run, `actions/checkout` checks out the merge of the pull request into its base,
so `HEAD^` is the base:

```yaml
on: pull_request

jobs:
  dependencies:
    runs-on: ubuntu-latest
    # Optional: Dependabot's grouped minor-and-patch PRs don't move a dependency
    # to a new major version even when one is out, so they'd fail this.
    if: github.event.pull_request.user.login != 'dependabot[bot]'
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 2
      - uses: actions/setup-node@v7
      - run: npm ci
      - run: npx latest-or-bust HEAD^
```

## What it checks

- The root `package.json` and every workspace package's: the `packages` in `pnpm-workspace.yaml`,
  and npm's `workspaces` in the root `package.json` (globs and `!` exclusions included). Other
  `package.json` files, such as test fixtures, are left out.
- In each, `dependencies`, `devDependencies` and `optionalDependencies`. `peerDependencies` are left
  out, since they're deliberately wide ranges rather than what gets installed.
- pnpm's catalogs, default and named, in `pnpm-workspace.yaml`.

A dependency counts as changed when its version spec changes at all, so a range whose floor isn't the
newest release fails too (`^1.1.0` when 1.2.0 is out). Specs that don't name a registry version
(`workspace:`, `catalog:`, `file:`, `link:`, `npm:` aliases, git URLs) are skipped; a catalog's
entries are checked in the catalog.

The newest release comes from [npm-check-updates](https://github.com/raineorshine/npm-check-updates),
which reads your registry settings from `.npmrc`, and honors the package manager's release-age
cooldown, so it never asks for a release your package manager won't install yet:

- npm: `min-release-age` in `.npmrc`
- pnpm: `minimumReleaseAge` in `pnpm-workspace.yaml` (a project with `pnpm-workspace.yaml` or
  `pnpm-lock.yaml` is a pnpm project)

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

npm and pnpm are supported. Yarn and Bun are planned.

## Requirements

Node.js 22.22.2 or later on the 22 line, 24.15.0 or later on the 24 line, or 26 and later; and git.

## License

MIT

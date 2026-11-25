# latest-or-bust

Fail CI when a change adds or changes an npm dependency that isn't on its latest version.

Dependabot and Renovate keep the dependencies you already have up to date. They don't stop a pull
request from adding a new dependency at an old version, or from upgrading one only part of the way
(say from 1.0.0 to 1.1.0 when 1.2.0 is out). latest-or-bust does: it finds every dependency a change
adds, or changes the version of, and fails if any of them isn't the newest release. Dependencies the
change leaves alone aren't checked, so it never fails a pull request for something it didn't touch.

```console
$ npx latest-or-bust
Checking dependencies added or changed since origin/main (3c23f15…)
package.json: hono, react
packages/web/package.json: vite

Not the newest release:
  package.json  react  ^19.3.1 → ^19.3.2
  packages/web/package.json  vite  7.4.0 → 7.5.1

Update them, or if one is held back on purpose, add it to `reject` in the root .ncurc file with a comment saying why.
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
- pnpm: `minimumReleaseAge` in `pnpm-workspace.yaml` (npm-check-updates knows it's a pnpm project by
  its `pnpm-lock.yaml`)

## Holding a dependency back

To keep a dependency on an older version on purpose, add it to `reject` in an
[npm-check-updates config file](https://github.com/raineorshine/npm-check-updates#config-file) at the
repository root, with a comment saying why. latest-or-bust reads that file for every package in the
workspace. For example, `.ncurc.cjs`:

```js
module.exports = {
  reject: [
    // @types/foo only covers 1.x, and foo 2 ships no types of its own
    "foo",
  ],
};
```

A rejected dependency is skipped entirely, so take it off the list once the reason is gone.

## Package managers

npm and pnpm are supported. Yarn and Bun are planned.

## Requirements

Node.js 22.22.2 or later on the 22 line, 24.15.0 or later on the 24 line, or 26 and later; and git.

## License

MIT

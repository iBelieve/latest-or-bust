# Changelog

Notable changes to latest-or-bust. Versions follow [semantic versioning](https://semver.org); while
it's below 1.0, a minor version may change behaviour.

## Unreleased

- On GitHub Actions, a pull request from `develop` into `main` or `master` passes without a check,
  like a push: its dependencies were checked on their way into `develop`. Pull requests from a
  fork's `develop` are still checked. `promotions` in `latest-or-bust.json` names other branches
  (`[{ "from": "next", "into": "main" }]`), or turns this off (`[]`).

## 0.2.0

Yarn and Bun support, and no setup needed on GitHub Actions with `actions/checkout`'s defaults.

- Yarn and Bun projects. The package manager is the one `package.json`'s `packageManager` names,
  else the one whose lockfile, else config file (a `bunfig.toml` only with an `[install]` table), is
  at the root, so a project that names pnpm only in `packageManager` now counts as pnpm too. The
  other way round, `pnpm-workspace.yaml` or `pnpm-lock.yaml` no longer makes a project pnpm when
  `packageManager` names another package manager, and `pnpm-workspace.yaml` doesn't when another
  one's lockfile is at the root and `pnpm-lock.yaml` isn't.
- Checks Yarn's catalogs in `.yarnrc.yml` and Bun's in the root `package.json`.
- Honors Yarn's `npmMinimalAgeGate` (with `npmPreapprovedPackages`, in the root `.yarnrc.yml` or
  `~/.yarnrc.yml`, with or without `yarn.lock`) and Bun's `minimumReleaseAge` (with
  `minimumReleaseAgeExcludes`, in `bunfig.toml` or the global `.bunfig.toml`).
- A dependency in more than one of `dependencies`, `devDependencies` and `optionalDependencies` is
  checked in each section, by its spec there. Before, only one section's spec was compared, so a
  change to the other could go unnoticed. The report names the section for such a dependency. A
  dependency moved to another section with the same spec still counts as unchanged, but one
  changed to the spec it has in another section is checked.
- pnpm 11 and later's default `minimumReleaseAge` of a day applies when nothing sets one, so the
  check no longer asks for a release pnpm won't install yet. `minimumReleaseAgeExclude` still
  applies, and so does `PNPM_CONFIG_MINIMUM_RELEASE_AGE` on pnpm 11 and later.
- "Nothing to check" is no longer printed when a dependency exempt in two sections or catalogs
  hides one that was checked.
- On GitHub Actions, with no base revision, it works out what to compare with: a `pull_request` run
  compares with the pull request's base (fetching that commit into a shallow clone), and any other
  run, along with pull requests from Dependabot and Renovate, passes with a note that there's nothing
  to check. A base revision passed on the command line still wins. A workflow no longer needs
  `fetch-depth: 2`, `HEAD^` or an `if:` on the event, except in a private repository checked out
  with `persist-credentials: false`, where the fetch has no credentials.
- The README credits npm-check-updates, which latest-or-bust is built on, near the top and in a new
  Acknowledgments section.

## 0.1.0

The first release: the new-dependency check from iBelieve/ehymnboard, as a package.

- `latest-or-bust [base revision]` fails if a dependency added, or whose version spec changed, since
  the base isn't the newest release, including an upgrade that stops short of it.
- Checks the root `package.json`, every workspace package's (pnpm-workspace.yaml's `packages` and
  npm's `workspaces`, with globs) and pnpm's default and named catalogs, for npm and pnpm projects.
- Honors npm's `min-release-age` and pnpm's `minimumReleaseAge`.
- Fails on a dependency it can't look up (not on the registry, or the registry unreachable or
  refusing the login), rather than passing it.
- Exemptions, each with a reason, in `latest-or-bust.json`; `"allow": "minor"` lets a dependency stay
  on its major as long as it's the newest release there.

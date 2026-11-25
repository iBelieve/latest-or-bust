# Changelog

Notable changes to latest-or-bust. Versions follow [semantic versioning](https://semver.org); while
it's below 1.0, a minor version may change behaviour.

## Unreleased

- A dependency in more than one of `dependencies`, `devDependencies` and `optionalDependencies` is
  checked in each section, by its spec there. Before, only one section's spec was compared, so a
  change to the other could go unnoticed. The report names the section for such a dependency.
- pnpm 11 and later's default `minimumReleaseAge` of a day applies when nothing sets one, so the
  check no longer asks for a release pnpm won't install yet. `minimumReleaseAgeExclude` still
  applies.
- "Nothing to check" is no longer printed when a dependency exempt in two sections or catalogs of a
  file hides one that was checked.

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

# Changelog

Notable changes to latest-or-bust. Versions follow [semantic versioning](https://semver.org); while
it's below 1.0, a minor version may change behaviour.

## Unreleased

- Yarn and Bun projects: the package manager is the one `package.json`'s `packageManager` names, else
  the one whose lockfile, else config file, is at the root.
- Checks Yarn's catalogs in `.yarnrc.yml` and Bun's in the root `package.json`.
- Honors Yarn's `npmMinimalAgeGate` and Bun's `minimumReleaseAge` (with
  `minimumReleaseAgeExcludes`, in `bunfig.toml` or the global `.bunfig.toml`).

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

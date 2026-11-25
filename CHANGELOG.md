# Changelog

Notable changes to latest-or-bust. Versions follow [semantic versioning](https://semver.org); while
it's below 1.0, a minor version may change behaviour.

## Unreleased

- On GitHub Actions, with no base revision, it works out what to compare with: a `pull_request` run
  compares with the pull request's base (fetching that commit into a shallow clone), and any other
  run, along with pull requests from Dependabot and Renovate, passes with a note that there's nothing
  to check. A base revision passed on the command line still wins. A workflow no longer needs
  `fetch-depth: 2`, `HEAD^` or an `if:` on the event.

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

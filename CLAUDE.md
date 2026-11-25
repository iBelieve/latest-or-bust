# latest-or-bust

A CLI, published to npm, that fails when a change adds or changes an npm
dependency that isn't the newest release. `src/` is TypeScript, built to
`dist/` with `tsc` for npm (Node.js won't strip types under `node_modules`);
the tests run the TypeScript directly. See `README.md` for what it checks.

- `src/manifests.ts`: pure functions over file contents (specs, workspace
  patterns, what changed). `src/git.ts`: the base revision and files at it.
  `src/config.ts`: `latest-or-bust.json`, the exemptions (each needs a
  reason); `schema.json` describes it for editors. `src/ncu.ts`: runs
  npm-check-updates' own command line (so it reads `.npmrc` and the
  package manager's cooldown just as `ncu` does), with a config file of its
  own (`ncurc.mjs`, which reports the packages it could look up, so a failed
  lookup fails the check) and options pinned, so a project's `.ncurc` can't
  change what it does. `src/pnpm.ts`: pnpm 11+'s default `minimumReleaseAge`,
  which npm-check-updates only applies when it's set, given to it as a copy
  of pnpm's global config. `src/check.ts` ties them together, asking about
  each package.json section on its own; `src/cli.ts` is the command
- `src/github.ts`: on GitHub Actions, the base when none is passed (a pull
  request's), or that the run has nothing to check
- latest-or-bust's own config is the interface; npm-check-updates is an
  implementation detail that could be swapped out, so don't expose its
  options
- npm-check-updates runs asynchronously on purpose: the tests' fake registry
  (`test/fixtures.ts`) answers from the test's own process, so a synchronous
  spawn would deadlock
- Only erasable TypeScript syntax (no enums or parameter properties); import
  with `.ts` extensions (`rewriteRelativeImportExtensions` makes them `.js`
  in `dist/`)
- npm and pnpm are supported; Yarn and Bun come in later PRs

## Checks

CI (`.github/workflows/ci.yml`) runs all of these; run them before
committing. `All green` is the one required status check: a new job only
needs a line in its `needs`.

- `pnpm install` (pnpm from `packageManager`, Node.js from `.node-version`)
- `pnpm run format:check` (Prettier), `pnpm run typecheck` (TypeScript 7),
  `pnpm run lint` (oxlint with type-aware rules via tsrs, all errors),
  `pnpm run build`
- `pnpm run fallow` (Fallow's `dead-code`, then `dupes`): fails on unused
  files, exports and dependencies (dev ones too), import cycles and
  duplicated code. Remove what's really unused, or record a deliberate
  exception in `.fallowrc.json` or with a
  `// fallow-ignore-next-line <rule> -- why` comment (a reason is required)
- `pnpm test` (node:test; CI runs it on Node.js 22, 24 and 26, the lines
  `engines` allows). The tests use throwaway git repositories and a fake
  registry, never the real one. `test/*.property.test.ts` are fast-check
  property tests of the pure functions (200 cases each;
  `FC_RUNS=10000 pnpm test` searches harder; a failure prints a shrunk
  counterexample and a seed)
- `pnpm run test:coverage`, then `pnpm run health` (Fallow's
  `health --complexity --coverage-gaps`): fails on any function with
  cyclomatic complexity over 20, cognitive complexity over 15 or a CRAP
  score of 30 or more, from the tests' V8 coverage in `coverage/`
  (`NODE_V8_COVERAGE`, so the CLI's subprocesses count), and on a source
  file no test reaches. No baseline: split the function, or for CRAP, test it
- `pnpm run mutation --base <ref>` (Fallow's mutation testing): changes the
  lines changed since the ref in small ways and runs the tests that cover
  them against each change; a change no test fails on survives. CI runs it
  against `HEAD^` and annotates each survivor on its line, without failing
  (some survivors are equivalent to the original). Kill a real survivor
  with a test. `pnpm run mutation --all` mutates everything (slow: the CLI
  tests take seconds a run)
- `pnpm run smoke` (`scripts/smoke-test.sh`): packs the package, installs it
  with npm in a throwaway directory and runs the installed command against
  the real registry, which must pass a dependency at its newest release and
  fail an old one
- `node dist/cli.js`: latest-or-bust checks its own dependencies (against a
  pull request's base; other runs pass), so add a dependency at its newest
  release
- actionlint over the workflows, shellcheck over `scripts/*.sh`, and
  [zizmor](https://docs.zizmor.sh) (`pipx run zizmor .github/workflows`)
  for workflow security. Actions are pinned to a commit with the version in
  a comment (`@<sha> # v7.0.1`), which Dependabot keeps current; pin a new
  one the same way, and set `persist-credentials: false` on checkouts
- `minimumReleaseAge` in `pnpm-workspace.yaml` rejects releases under a day
  old, so don't pin a version published today

## Releasing

Bump `version` in `package.json`, move `CHANGELOG.md`'s Unreleased entries
under the new version, merge, then publish a GitHub release tagged
`v<version>`. `.github/workflows/publish.yml` checks the tag matches, runs
the checks and stages the version on npm with provenance through npm trusted
publishing (`npm stage publish`); Michael approves it with 2FA on npmjs.com
before it's live. Record user-visible changes under Unreleased in
`CHANGELOG.md` as they land.

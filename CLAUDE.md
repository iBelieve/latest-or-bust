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
  package manager's cooldown just as `ncu` does), with an empty config file
  (`ncurc.empty.json`) and options pinned, so a project's `.ncurc` can't
  change what it does. `src/check.ts` ties them together; `src/cli.ts` is
  the command
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
- `pnpm test` (node:test; CI runs it on Node.js 22, 24 and 26, the lines
  `engines` allows). The tests use throwaway git repositories and a fake
  registry, never the real one
- On pull requests, `node dist/cli.js HEAD^`: latest-or-bust checks its own
  dependencies, so add a dependency at its newest release
- actionlint over the workflows
- `minimumReleaseAge` in `pnpm-workspace.yaml` rejects releases under a day
  old, so don't pin a version published today

## Releasing

Michael publishes to npm by hand: bump `version` in `package.json`, then
`pnpm publish` (`prepack` builds `dist/`).

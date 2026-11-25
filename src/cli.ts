#!/usr/bin/env node
// latest-or-bust [base revision]: fails if a dependency added or changed since
// the base isn't the newest release. See README.md.

import { readdirSync, readFileSync } from "node:fs";
import { check, type CheckResult, type Place } from "./check.ts";
import { CONFIG_FILE } from "./config.ts";
import { defaultBase, repositoryRoot, resolveCommit } from "./git.ts";
import { isRecord } from "./manifests.ts";

const USAGE = `Usage: latest-or-bust [base revision]

Fails if a dependency that the working tree adds, or changes the version of,
since the base revision isn't the newest release npm-check-updates finds
(after the package manager's release-age cooldown, such as pnpm's
minimumReleaseAge, a day by default since pnpm 11). Checks the root
package.json, every workspace package's, and pnpm-workspace.yaml's catalogs.

The base defaults to where HEAD branched from origin's default branch. On a
GitHub pull_request run, pass HEAD^ (with actions/checkout's fetch-depth: 2).

To hold a dependency back on purpose, exempt it in latest-or-bust.json at the
repository root, with the reason why:

  { "exempt": { "foo": { "reason": "foo 3 drops Node.js 22", "allow": "minor" } } }

"allow": "minor" still wants the newest release on its current major; without
it, the dependency isn't checked.

Options:
  -h, --help     Show this help
  -v, --version  Show the version`;

function version(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  return isRecord(manifest) && typeof manifest["version"] === "string"
    ? manifest["version"]
    : "unknown";
}

/** A file, with the named catalog or the package.json section when there is one. */
function where({ file, catalog, section }: Place): string {
  if (catalog !== undefined) return `${file} (catalog ${catalog})`;
  return section === undefined ? file : `${file} (${section})`;
}

function report(result: CheckResult): boolean {
  if (result.checked.size === 0) {
    console.log("No dependencies were added or changed.");
    return true;
  }
  for (const [file, names] of result.checked) {
    console.log(`${file}: ${names.join(", ")}`);
  }
  if (result.exempted.length > 0) {
    console.log(`\nExempt in ${CONFIG_FILE}:`);
    for (const exempted of result.exempted) {
      const how = exempted.allow === "minor" ? "newest on its major" : "not checked";
      console.log(`  ${where(exempted)}  ${exempted.name}  (${how}: ${exempted.reason})`);
    }
  }
  if (result.notFound.length > 0) {
    console.error(
      "\nNo release found (not on the registry, or the registry unreachable or refusing the login):",
    );
    for (const notFound of result.notFound) {
      console.error(`  ${where(notFound)}  ${notFound.name}  ${notFound.spec}`);
    }
  }
  if (result.outdated.length === 0) {
    if (result.notFound.length > 0) return false;
    // By file and name: one can be in more than one section or catalog of a file.
    const unchecked = new Set(
      result.exempted
        .filter((exempted) => exempted.allow === undefined)
        .map(({ file, name }) => `${file}\0${name}`),
    );
    const total = [...result.checked.values()].reduce((sum, names) => sum + names.length, 0);
    console.log(
      unchecked.size >= total
        ? `\nNothing to check: ${CONFIG_FILE} exempts all of them.`
        : "\nAll of them are the newest release.",
    );
    return true;
  }
  console.error("\nNot the newest release:");
  for (const outdated of result.outdated) {
    // Already exempt with "allow": "minor", so it's behind on its own major.
    const on =
      outdated.allow === "minor" ? ` (the newest on its major, as ${CONFIG_FILE} allows)` : "";
    console.error(
      `  ${where(outdated)}  ${outdated.name}  ${outdated.spec} → ${outdated.latest}${on}`,
    );
  }
  console.error(
    `\nUpdate them, or if one is held back on purpose, exempt it in ${CONFIG_FILE} with the reason why.`,
  );
  return false;
}

/** An error's message, followed by its causes'. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined ? error.message : `${error.message}: ${describe(error.cause)}`;
}

async function main(args: string[]): Promise<boolean> {
  const [first, ...rest] = args;
  if (first === "-h" || first === "--help") {
    console.log(USAGE);
    return true;
  }
  if (first === "-v" || first === "--version") {
    console.log(version());
    return true;
  }
  if (rest.length > 0 || first?.startsWith("-")) {
    console.error(USAGE);
    return false;
  }
  const root = repositoryRoot(process.cwd());
  const ncurc = readdirSync(root).filter((file) => /^\.ncurc(\.[a-z]+)?$/.test(file));
  if (ncurc.length > 0) {
    console.error(
      `Note: latest-or-bust doesn't read ${ncurc.join(", ")}; it takes its exemptions from ${CONFIG_FILE}.`,
    );
  }
  const requested = first ?? defaultBase(root);
  const base = resolveCommit(root, requested);
  console.log(
    `Checking dependencies added or changed since ${requested === base ? base : `${requested} (${base})`}`,
  );
  return report(await check({ root, base }));
}

try {
  if (!(await main(process.argv.slice(2)))) process.exitCode = 1;
} catch (error) {
  console.error(describe(error));
  process.exitCode = 1;
}

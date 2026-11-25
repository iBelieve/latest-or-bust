// Checks that every dependency a change adds, or changes the version of, is
// the newest release: in the root package.json, each workspace package's, and
// pnpm-workspace.yaml's catalogs. Dependencies the change leaves alone aren't
// checked: keeping those current is a job for Dependabot or Renovate.

import { posix } from "node:path";
import { atRevision, inWorkingTree, packageDirectories } from "./git.ts";
import {
  catalogSpecs,
  changedNames,
  hasPackagesList,
  manifestSpecs,
  matchWorkspaces,
  workspacePatterns,
  type Specs,
} from "./manifests.ts";
import { catalogUpgrades, manifestUpgrades, type NcuOptions, type Upgrades } from "./ncu.ts";

const PNPM_WORKSPACE = "pnpm-workspace.yaml";

export interface Outdated {
  /** The file it's in, relative to the root. */
  file: string;
  name: string;
  /** Its version spec there. */
  spec: string;
  /** The spec npm-check-updates would upgrade it to. */
  latest: string;
}

export interface CheckResult {
  /** Each file with added or changed dependencies, with their names. */
  checked: Map<string, string[]>;
  outdated: Outdated[];
}

export interface CheckOptions extends NcuOptions {
  /** The commit to compare the working tree with. */
  base: string;
}

/** Runs `parse`, naming the file and revision if it isn't valid. */
function parsing<T>(where: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new Error(`Can't parse ${where}`, { cause: error });
  }
}

/**
 * `name`'s spec in `specs`. npm-check-updates names a catalog entry by its
 * package name alone, so for a catalog this is the default catalog's spec,
 * else the first named catalog's.
 */
function specFor(specs: Specs, name: string): string {
  const spec = specs.get(name);
  if (spec !== undefined) return spec;
  for (const [key, value] of specs) {
    if (key.endsWith(`:${name}`)) return value;
  }
  return "";
}

function outdatedIn(file: string, current: Specs, upgrades: Upgrades): Outdated[] {
  return [...upgrades].map(([name, latest]) => ({
    file,
    name,
    spec: specFor(current, name),
    latest,
  }));
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const { root, base } = options;
  const result: CheckResult = { checked: new Map(), outdated: [] };
  const before = (path: string) => atRevision(root, base, path);
  const now = (path: string) => inWorkingTree(root, path);

  const workspace = now(PNPM_WORKSPACE);
  const patterns = parsing(`the workspace packages in package.json or ${PNPM_WORKSPACE}`, () =>
    workspacePatterns(now("package.json"), workspace),
  );
  const dirs = [".", ...matchWorkspaces(patterns, packageDirectories(root))];

  for (const dir of dirs) {
    // A git path, so always with forward slashes.
    const manifest = posix.join(dir, "package.json");
    const current = parsing(manifest, () => manifestSpecs(now(manifest)));
    const previous = parsing(`${manifest} at ${base}`, () => manifestSpecs(before(manifest)));
    const names = changedNames(previous, current);
    if (names.length === 0) continue;
    result.checked.set(manifest, names);
    result.outdated.push(
      ...outdatedIn(manifest, current, await manifestUpgrades(options, manifest, names)),
    );
  }

  const catalog = parsing(PNPM_WORKSPACE, () => catalogSpecs(workspace));
  const previousCatalog = parsing(`${PNPM_WORKSPACE} at ${base}`, () =>
    catalogSpecs(before(PNPM_WORKSPACE)),
  );
  const catalogNames = changedNames(previousCatalog, catalog);
  if (catalogNames.length > 0) {
    if (!hasPackagesList(workspace)) {
      // npm-check-updates checks catalogs only in a workspace, and without a
      // packages list it fails without saying why.
      throw new Error(
        `${PNPM_WORKSPACE}'s catalogs changed, but it lists no packages, so npm-check-updates can't check them: add a packages list`,
      );
    }
    result.checked.set(PNPM_WORKSPACE, catalogNames);
    result.outdated.push(
      ...outdatedIn(PNPM_WORKSPACE, catalog, await catalogUpgrades(options, catalogNames)),
    );
  }
  return result;
}

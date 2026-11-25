// Checks that every dependency a change adds, or changes the version of, is
// the newest release: in the root package.json, each workspace package's, and
// pnpm-workspace.yaml's catalogs. Dependencies the change leaves alone aren't
// checked: keeping those current is a job for Dependabot or Renovate.

import { posix } from "node:path";
import { atRevision, inWorkingTree, packageDirectories } from "./git.ts";
import {
  catalogSpecs,
  changedEntries,
  changedNames,
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

function outdatedIn(file: string, current: Specs, upgrades: Upgrades): Outdated[] {
  return [...upgrades].map(([name, latest]) => ({
    file,
    name,
    spec: current.get(name) ?? "",
    latest,
  }));
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const { root, base } = options;
  const result: CheckResult = { checked: new Map(), outdated: [] };
  const before = (path: string) => atRevision(root, base, path);
  const now = (path: string) => inWorkingTree(root, path);

  const rootManifest = now("package.json");
  const workspace = now(PNPM_WORKSPACE);
  const previousWorkspace = before(PNPM_WORKSPACE);
  if (
    rootManifest === undefined &&
    workspace === undefined &&
    previousWorkspace === undefined &&
    before("package.json") === undefined
  ) {
    // Otherwise a project in a subdirectory would pass without a check.
    throw new Error(
      `There's no package.json or ${PNPM_WORKSPACE} at the repository root (${root}), or at ${base}: latest-or-bust checks the project there`,
    );
  }
  const patterns = parsing(`the workspace packages in package.json or ${PNPM_WORKSPACE}`, () =>
    workspacePatterns(rootManifest, workspace),
  );
  const dirs = [".", ...matchWorkspaces(patterns, packageDirectories(root))];

  for (const dir of dirs) {
    // A git path, so always with forward slashes.
    const manifest = posix.join(dir, "package.json");
    const [text, previousText] = [now(manifest), before(manifest)];
    const current = parsing(manifest, () => manifestSpecs(text));
    const previous = parsing(`${manifest} at ${base}`, () => manifestSpecs(previousText));
    const names = changedNames(previous, current);
    if (names.length === 0) continue;
    result.checked.set(manifest, names);
    result.outdated.push(
      ...outdatedIn(manifest, current, await manifestUpgrades(options, manifest, names)),
    );
  }

  const catalog = parsing(PNPM_WORKSPACE, () => catalogSpecs(workspace));
  const previousCatalog = parsing(`${PNPM_WORKSPACE} at ${base}`, () =>
    catalogSpecs(previousWorkspace),
  );
  const catalogNames = changedNames(previousCatalog, catalog);
  if (catalogNames.length > 0) {
    result.checked.set(PNPM_WORKSPACE, catalogNames);
    // Each catalog on its own, so each entry is judged by its own spec.
    for (const entries of changedEntries(previousCatalog, catalog).values()) {
      result.outdated.push(
        ...outdatedIn(PNPM_WORKSPACE, entries, await catalogUpgrades(options, entries)),
      );
    }
  }
  return result;
}

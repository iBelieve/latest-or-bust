// Checks that every dependency a change adds, or changes the version of, is
// the newest release: in the root package.json, each workspace package's, and
// pnpm-workspace.yaml's catalogs. Dependencies the change leaves alone aren't
// checked: keeping those current is a job for Dependabot or Renovate.

import { posix } from "node:path";
import { CONFIG_FILE, parseConfig, type Config } from "./config.ts";
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
import { newerReleases, type NcuOptions, type NcuQuery, type Upgrades } from "./ncu.ts";

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

export interface Exempted {
  file: string;
  name: string;
  reason: string;
  /** "minor" if it was checked against the newest release on its major; undefined if it wasn't checked. */
  allow?: "minor";
}

export interface CheckResult {
  /** Each file with added or changed dependencies, with their names (exempt ones too). */
  checked: Map<string, string[]>;
  /** The added or changed dependencies latest-or-bust.json exempts. */
  exempted: Exempted[];
  outdated: Outdated[];
}

export interface CheckOptions {
  /** The repository root. */
  root: string;
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

/**
 * Asks about one file's changed dependencies, minus the exempt ones: those
 * allowed to stay on their major are asked about with target "minor", and
 * the rest aren't asked about at all.
 */
async function checkFile(
  ncu: NcuOptions,
  config: Config,
  result: CheckResult,
  file: string,
  query: Omit<NcuQuery, "names" | "target">,
  changed: Specs,
): Promise<void> {
  const latest: string[] = [];
  const minor: string[] = [];
  for (const name of changed.keys()) {
    const exemption = config.exempt.get(name);
    if (exemption === undefined) {
      latest.push(name);
      continue;
    }
    result.exempted.push({ file, name, ...exemption });
    if (exemption.allow === "minor") minor.push(name);
  }
  const outdated: Outdated[] = [];
  for (const [names, target] of [
    [latest, "latest"],
    [minor, "minor"],
  ] as const) {
    const found = await newerReleases(ncu, { ...query, names: [...names], target });
    outdated.push(...outdatedIn(file, changed, found));
  }
  result.outdated.push(...outdated.toSorted((a, b) => (a.name < b.name ? -1 : 1)));
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const { root, base } = options;
  const result: CheckResult = { checked: new Map(), exempted: [], outdated: [] };
  const before = (path: string) => atRevision(root, base, path);
  const now = (path: string) => inWorkingTree(root, path);
  const config = parseConfig(now(CONFIG_FILE));

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
  // A pnpm project, even without pnpm-lock.yaml (which npm-check-updates
  // would need to know it), so pnpm's cooldown applies.
  const isPnpm = workspace !== undefined || now("pnpm-lock.yaml") !== undefined;
  const ncu: NcuOptions = { root, ...(isPnpm ? { packageManager: "pnpm" } : {}) };
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
    const changed = changedEntries(previous, current).get("");
    if (changed === undefined) continue;
    result.checked.set(manifest, [...changed.keys()].toSorted());
    await checkFile(ncu, config, result, manifest, { packageFile: manifest }, changed);
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
      await checkFile(ncu, config, result, PNPM_WORKSPACE, { dependencies: entries }, entries);
    }
  }
  return result;
}

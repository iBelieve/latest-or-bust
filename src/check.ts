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

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : 1);

const PNPM_WORKSPACE = "pnpm-workspace.yaml";

/** Where a dependency is: a file, and for a named pnpm catalog, the catalog. */
export interface Place {
  /** The file it's in, relative to the root. */
  file: string;
  /** The named catalog in pnpm-workspace.yaml it's in; undefined elsewhere. */
  catalog?: string;
}

export interface Outdated extends Place {
  name: string;
  /** Its version spec there. */
  spec: string;
  /** The spec npm-check-updates would upgrade it to. */
  latest: string;
  /** "minor" if latest-or-bust.json lets it stay on its major, so `latest` is the newest there. */
  allow?: "minor";
}

export interface Exempted extends Place {
  name: string;
  reason: string;
  /** "minor" if it was checked against the newest release on its major; undefined if it wasn't checked. */
  allow?: "minor";
}

export interface NotFound extends Place {
  name: string;
  /** Its version spec there. */
  spec: string;
}

export interface CheckResult {
  /** Each file with added or changed dependencies, with their names (exempt ones too). */
  checked: Map<string, string[]>;
  /** The added or changed dependencies latest-or-bust.json exempts. */
  exempted: Exempted[];
  outdated: Outdated[];
  /**
   * The added or changed dependencies npm-check-updates found no release of:
   * not on the registry, or the registry unreachable or refusing the login.
   * They fail the check, since there's no telling if they're the newest.
   */
  notFound: NotFound[];
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

function outdatedIn(
  place: Place,
  current: Specs,
  upgrades: Upgrades,
  target: NcuQuery["target"],
): Outdated[] {
  return [...upgrades].map(([name, latest]) => ({
    ...place,
    name,
    spec: current.get(name) ?? "",
    latest,
    ...(target === "minor" ? { allow: target } : {}),
  }));
}

/**
 * Asks about one file's (or catalog's) changed dependencies, minus the
 * exempt ones: those allowed to stay on their major are asked about with
 * target "minor", and the rest aren't asked about at all.
 */
async function checkFile(
  ncu: NcuOptions,
  config: Config,
  result: CheckResult,
  place: Place,
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
    result.exempted.push({ ...place, name, ...exemption });
    if (exemption.allow === "minor") minor.push(name);
  }
  const outdated: Outdated[] = [];
  const notFound: NotFound[] = [];
  for (const [names, target] of [
    [latest, "latest"],
    [minor, "minor"],
  ] as const) {
    const found = await newerReleases(ncu, { ...query, names: [...names], target });
    outdated.push(...outdatedIn(place, changed, found.upgrades, target));
    for (const name of found.notFound) {
      notFound.push({ ...place, name, spec: changed.get(name) ?? "" });
    }
  }
  result.outdated.push(...outdated.toSorted(byName));
  result.notFound.push(...notFound.toSorted(byName));
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const { root, base } = options;
  const result: CheckResult = { checked: new Map(), exempted: [], outdated: [], notFound: [] };
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
    await checkFile(ncu, config, result, { file: manifest }, { packageFile: manifest }, changed);
  }

  const catalog = parsing(PNPM_WORKSPACE, () => catalogSpecs(workspace));
  const previousCatalog = parsing(`${PNPM_WORKSPACE} at ${base}`, () =>
    catalogSpecs(previousWorkspace),
  );
  const catalogNames = changedNames(previousCatalog, catalog);
  if (catalogNames.length > 0) {
    result.checked.set(PNPM_WORKSPACE, catalogNames);
    // Each catalog on its own, so each entry is judged by its own spec.
    for (const [named, entries] of changedEntries(previousCatalog, catalog)) {
      // The default catalog's name is "".
      const place: Place = { file: PNPM_WORKSPACE, ...(named === "" ? {} : { catalog: named }) };
      await checkFile(ncu, config, result, place, { dependencies: entries }, entries);
    }
  }
  return result;
}

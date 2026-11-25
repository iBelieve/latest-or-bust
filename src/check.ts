// Checks that every dependency a change adds, or changes the version of, is
// the newest release: in the root package.json, each workspace package's, and
// pnpm-workspace.yaml's catalogs. Dependencies the change leaves alone aren't
// checked: keeping those current is a job for Dependabot or Renovate.

import { rmSync } from "node:fs";
import { posix } from "node:path";
import { CONFIG_FILE, parseConfig, type Config } from "./config.ts";
import { atRevision, inWorkingTree, packageDirectories } from "./git.ts";
import {
  catalogSpecs,
  changedEntries,
  changedNames,
  MANIFEST_SECTIONS,
  manifestSpecs,
  matchWorkspaces,
  workspacePatterns,
  type Section,
  type Specs,
} from "./manifests.ts";
import { newerReleases, type NcuOptions, type NcuQuery, type Upgrades } from "./ncu.ts";
import { defaultCooldownConfig } from "./pnpm.ts";

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : 1);

const PNPM_WORKSPACE = "pnpm-workspace.yaml";

// npm-check-updates' name for each package.json section.
const NCU_DEP = {
  dependencies: "prod",
  devDependencies: "dev",
  optionalDependencies: "optional",
} as const satisfies Record<Section, NcuQuery["dep"]>;

/** Where a dependency is: a file, and for a named pnpm catalog, the catalog. */
export interface Place {
  /** The file it's in, relative to the root. */
  file: string;
  /** The named catalog in pnpm-workspace.yaml it's in; undefined elsewhere. */
  catalog?: string;
  /**
   * The package.json section it's in, when its name is in more than one
   * section of the file; undefined otherwise.
   */
  section?: Section;
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
  placeOf: (name: string) => Place,
  current: Specs,
  upgrades: Upgrades,
  target: NcuQuery["target"],
): Outdated[] {
  return [...upgrades].map(([name, latest]) => ({
    ...placeOf(name),
    name,
    spec: current.get(name) ?? "",
    latest,
    ...(target === "minor" ? { allow: target } : {}),
  }));
}

/**
 * npm-check-updates' options, worked out the first time it's asked about
 * something, so a change that touches no dependency doesn't run pnpm.
 */
type Ncu = () => Promise<NcuOptions>;

/**
 * Asks about one file's (or catalog's) changed dependencies, minus the
 * exempt ones: those allowed to stay on their major are asked about with
 * target "minor", and the rest aren't asked about at all.
 */
async function checkFile(
  ncu: Ncu,
  config: Config,
  result: CheckResult,
  placeOf: (name: string) => Place,
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
    result.exempted.push({ ...placeOf(name), name, ...exemption });
    if (exemption.allow === "minor") minor.push(name);
  }
  const outdated: Outdated[] = [];
  const notFound: NotFound[] = [];
  for (const [names, target] of [
    [latest, "latest"],
    [minor, "minor"],
  ] as const) {
    if (names.length === 0) continue;
    const found = await newerReleases(await ncu(), { ...query, names: [...names], target });
    outdated.push(...outdatedIn(placeOf, changed, found.upgrades, target));
    for (const name of found.notFound) {
      notFound.push({ ...placeOf(name), name, spec: changed.get(name) ?? "" });
    }
  }
  result.outdated.push(...outdated.toSorted(byName));
  result.notFound.push(...notFound.toSorted(byName));
}

/** Sorts `list` by name from `start` on. */
function sortFrom(list: { name: string }[], start: number): void {
  list.splice(start, list.length - start, ...list.slice(start).toSorted(byName));
}

/** Checks a package.json (a git path, so with forward slashes), one section at a time. */
async function checkManifest(
  ncu: Ncu,
  config: Config,
  result: CheckResult,
  { root, base }: CheckOptions,
  manifest: string,
): Promise<void> {
  const [text, previousText] = [inWorkingTree(root, manifest), atRevision(root, base, manifest)];
  const current = parsing(manifest, () => manifestSpecs(text));
  const previous = parsing(`${manifest} at ${base}`, () => manifestSpecs(previousText));
  // A name in more than one section is reported with the section it's in.
  const sections = (name: string) =>
    MANIFEST_SECTIONS.filter((section) => current[section].has(name)).length;
  const names = new Set<string>();
  const [outdated, notFound] = [result.outdated.length, result.notFound.length];
  for (const section of MANIFEST_SECTIONS) {
    const changed = changedEntries(previous[section], current[section]).get("");
    if (changed === undefined) continue;
    // Moved from another section with the same spec: its version didn't change.
    for (const [name, spec] of changed) {
      if (MANIFEST_SECTIONS.some((other) => previous[other].get(name) === spec)) {
        changed.delete(name);
      }
    }
    if (changed.size === 0) continue;
    for (const name of changed.keys()) names.add(name);
    const placeOf = (name: string): Place =>
      sections(name) > 1 ? { file: manifest, section } : { file: manifest };
    const query = { packageFile: manifest, dep: NCU_DEP[section] };
    await checkFile(ncu, config, result, placeOf, query, changed);
  }
  if (names.size === 0) return;
  result.checked.set(manifest, [...names].toSorted());
  // Sorted by name across the sections too.
  sortFrom(result.outdated, outdated);
  sortFrom(result.notFound, notFound);
}

/** Checks pnpm-workspace.yaml's catalogs, each on its own, so each entry is judged by its own spec. */
async function checkCatalogs(
  ncu: Ncu,
  config: Config,
  result: CheckResult,
  base: string,
  workspace: string | undefined,
  previousWorkspace: string | undefined,
): Promise<void> {
  const catalog = parsing(PNPM_WORKSPACE, () => catalogSpecs(workspace));
  const previousCatalog = parsing(`${PNPM_WORKSPACE} at ${base}`, () =>
    catalogSpecs(previousWorkspace),
  );
  const catalogNames = changedNames(previousCatalog, catalog);
  if (catalogNames.length === 0) return;
  result.checked.set(PNPM_WORKSPACE, catalogNames);
  for (const [named, entries] of changedEntries(previousCatalog, catalog)) {
    // The default catalog's name is "".
    const place: Place = { file: PNPM_WORKSPACE, ...(named === "" ? {} : { catalog: named }) };
    const query = { dependencies: entries, dep: "prod" } as const;
    await checkFile(ncu, config, result, () => place, query, entries);
  }
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
  const patterns = parsing(`the workspace packages in package.json or ${PNPM_WORKSPACE}`, () =>
    workspacePatterns(rootManifest, workspace),
  );
  const dirs = [".", ...matchWorkspaces(patterns, packageDirectories(root))];
  let pnpmConfigHome: string | undefined;
  let ncuOptions: Promise<NcuOptions> | undefined;
  const ncu: Ncu = () =>
    (ncuOptions ??= (async (): Promise<NcuOptions> => {
      pnpmConfigHome = isPnpm
        ? await defaultCooldownConfig(root, rootManifest, workspace)
        : undefined;
      return {
        root,
        ...(isPnpm ? { packageManager: "pnpm" } : {}),
        ...(pnpmConfigHome === undefined ? {} : { pnpmConfigHome }),
      };
    })());
  try {
    for (const dir of dirs)
      await checkManifest(ncu, config, result, options, posix.join(dir, "package.json"));
    await checkCatalogs(ncu, config, result, base, workspace, previousWorkspace);
  } finally {
    if (pnpmConfigHome !== undefined) rmSync(pnpmConfigHome, { recursive: true, force: true });
  }
  return result;
}

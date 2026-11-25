// Checks that every dependency a change adds, or changes the version of, is
// the newest release: in the root package.json, each workspace package's, and
// the catalogs (pnpm-workspace.yaml's, .yarnrc.yml's and Bun's in the root
// package.json). Dependencies the change leaves alone aren't checked: keeping
// those current is a job for Dependabot or Renovate.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { CONFIG_FILE, parseConfig, type Config } from "./config.ts";
import { atRevision, inWorkingTree, packageDirectories } from "./git.ts";
import {
  catalogSpecs,
  changedEntries,
  changedNames,
  manifestCatalogSpecs,
  manifestSpecs,
  matchWorkspaces,
  workspacePatterns,
  type Specs,
} from "./manifests.ts";
import { newerReleases, type NcuOptions, type NcuQuery, type Upgrades } from "./ncu.ts";
import {
  bunCooldown,
  detectPackageManager,
  MARKER_FILES,
  type Cooldown,
} from "./packageManager.ts";

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : 1);

const PNPM_WORKSPACE = "pnpm-workspace.yaml";
const BUNFIG = "bunfig.toml";

/**
 * Where catalogs are defined, by file: pnpm's and Yarn's own files, and
 * Bun's root package.json. Each is checked whichever the package manager,
 * since only the one it reads would have catalogs.
 */
const CATALOGS: [file: string, specs: (text: string | undefined) => Specs][] = [
  [PNPM_WORKSPACE, catalogSpecs],
  [".yarnrc.yml", catalogSpecs],
  ["package.json", manifestCatalogSpecs],
];

/** Where a dependency is: a file, and for a catalog entry, the catalog when the file doesn't say. */
export interface Place {
  /** The file it's in, relative to the root. */
  file: string;
  /**
   * The catalog it's in: a named catalog's name, or "default" for the
   * default catalog in package.json (pnpm-workspace.yaml's and
   * .yarnrc.yml's default catalog leave it undefined). Undefined for a
   * package's own dependencies.
   */
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
  /**
   * Each file with added or changed dependencies, with their names (exempt
   * ones too); "package.json catalogs" for the root package.json's catalogs.
   */
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

/**
 * Bun's cooldown in the project: its bunfig.toml's settings, else the global
 * bunfig.toml's ($XDG_CONFIG_HOME/.bunfig.toml, else ~/.bunfig.toml), else
 * none.
 */
function bunCooldownAt(root: string): Cooldown {
  const global = join(process.env["XDG_CONFIG_HOME"] || homedir(), ".bunfig.toml");
  const globalText = existsSync(global) ? readFileSync(global, "utf8") : undefined;
  const where = globalText === undefined ? BUNFIG : `${BUNFIG} or ${global}`;
  const cooldown = parsing(where, () => bunCooldown(inWorkingTree(root, BUNFIG), globalText));
  return cooldown ?? { minutes: 0, exclude: [] };
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
  const present = new Set(MARKER_FILES.filter((file) => existsSync(join(root, file))));
  const packageManager = parsing("package.json", () => detectPackageManager(rootManifest, present));
  // npm-check-updates reads the others' cooldowns itself, but not Bun's. It's
  // passed even when unset: given none, npm-check-updates would take npm's
  // min-release-age from .npmrc, which Bun doesn't read.
  const cooldown = packageManager === "bun" ? bunCooldownAt(root) : undefined;
  const ncu: NcuOptions = { root, packageManager, ...(cooldown === undefined ? {} : { cooldown }) };
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

  for (const [file, specs] of CATALOGS) {
    const catalog = parsing(file, () => specs(now(file)));
    const previousCatalog = parsing(`${file} at ${base}`, () => specs(before(file)));
    const catalogNames = changedNames(previousCatalog, catalog);
    if (catalogNames.length === 0) continue;
    // package.json's own dependencies are listed under its name.
    const isManifest = file === "package.json";
    result.checked.set(isManifest ? `${file} catalogs` : file, catalogNames);
    // Each catalog on its own, so each entry is judged by its own spec.
    for (const [named, entries] of changedEntries(previousCatalog, catalog)) {
      // The default catalog's name is "".
      const name = named === "" && isManifest ? "default" : named;
      const place: Place = { file, ...(name === "" ? {} : { catalog: name }) };
      await checkFile(ncu, config, result, place, { dependencies: entries }, entries);
    }
  }
  return result;
}

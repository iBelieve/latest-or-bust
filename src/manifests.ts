// Finds the dependencies a change adds, or whose version it changes, by
// comparing manifests before and after it: each package.json and the catalogs
// in pnpm-workspace.yaml. Pure functions over file contents, so the tests need
// neither git nor a registry.

import { posix } from "node:path";
import { parse } from "yaml";

/** Dependency name to version spec. */
export type Specs = Map<string, string>;

// Sections of package.json whose versions get installed. peerDependencies are
// left out: they're deliberately wide ranges, not what gets installed.
const MANIFEST_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addStrings(specs: Specs, section: unknown, prefix = ""): void {
  if (!isRecord(section)) return;
  for (const [name, spec] of Object.entries(section)) {
    if (typeof spec === "string") specs.set(prefix + name, spec);
  }
}

function parseManifest(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  const manifest: unknown = JSON.parse(text);
  return isRecord(manifest) ? manifest : {};
}

function parseWorkspace(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  const workspace: unknown = parse(text);
  return isRecord(workspace) ? workspace : {};
}

/** The version specs in a package.json; empty when the file doesn't exist. */
export function manifestSpecs(text: string | undefined): Specs {
  const manifest = parseManifest(text);
  const specs: Specs = new Map();
  for (const section of MANIFEST_SECTIONS) addStrings(specs, manifest[section]);
  return specs;
}

/**
 * The version specs in pnpm-workspace.yaml's default catalog and named
 * catalogs. A name in more than one catalog is keyed by catalog
 * ("catalog:name"), so a change to any of them counts.
 */
export function catalogSpecs(text: string | undefined): Specs {
  const workspace = parseWorkspace(text);
  const specs: Specs = new Map();
  addStrings(specs, workspace["catalog"]);
  const named = workspace["catalogs"];
  if (isRecord(named)) {
    for (const [catalog, entries] of Object.entries(named)) {
      addStrings(specs, entries, `${catalog}:`);
    }
  }
  return specs;
}

function strings(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${where} must be a list of paths or globs`);
  }
  return value;
}

/**
 * The workspace package patterns: pnpm-workspace.yaml's `packages`, and the
 * root package.json's `workspaces` (npm, Yarn and Bun), either a list or an
 * object with a `packages` list.
 */
export function workspacePatterns(
  rootManifest: string | undefined,
  pnpmWorkspace: string | undefined,
): string[] {
  const workspaces = parseManifest(rootManifest)["workspaces"];
  return [
    ...strings(parseWorkspace(pnpmWorkspace)["packages"], "pnpm-workspace.yaml's packages"),
    ...strings(
      isRecord(workspaces) ? workspaces["packages"] : workspaces,
      "package.json's workspaces",
    ),
  ];
}

/** Whether pnpm-workspace.yaml has a packages list, even an empty one. */
export function hasPackagesList(pnpmWorkspace: string | undefined): boolean {
  return Array.isArray(parseWorkspace(pnpmWorkspace)["packages"]);
}

const normalize = (pattern: string): string =>
  posix.normalize(pattern).replace(/^\.\//, "").replace(/\/+$/, "");

const matchesAny = (dir: string, globs: string[]): boolean =>
  globs.some((glob) => posix.matchesGlob(dir, glob));

/**
 * The directories, out of `candidates` (relative to the root, with forward
 * slashes), that the workspace patterns take in: those matching a pattern
 * and no "!" exclusion. Sorted.
 */
export function matchWorkspaces(patterns: string[], candidates: string[]): string[] {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) exclude.push(normalize(pattern.slice(1)));
    else include.push(normalize(pattern));
  }
  return candidates
    .filter((dir) => matchesAny(dir, include) && !matchesAny(dir, exclude))
    .toSorted();
}

// Specs that don't name a registry version, such as "catalog:",
// "workspace:*", "link:../x", "file:x.tgz", "npm:other@1" or a git URL. A
// catalog's own entries are checked where they're defined.
function isRegistrySpec(spec: string): boolean {
  return !/^[a-z][a-z+]*:/i.test(spec);
}

/**
 * The names of dependencies that `head` adds or changes the version of,
 * sorted. Removed dependencies and non-registry specs are left out. Catalog
 * keys of the form "catalog:name" come back as the bare package name.
 */
export function changedNames(base: Specs, head: Specs): string[] {
  const names = new Set<string>();
  for (const [key, spec] of head) {
    if (base.get(key) === spec || !isRegistrySpec(spec)) continue;
    // A scoped name's "@" comes first, so a catalog prefix is whatever
    // precedes the first ":".
    names.add(key.slice(key.indexOf(":") + 1));
  }
  return [...names].toSorted();
}

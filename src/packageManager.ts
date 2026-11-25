// Which package manager a project uses, and the release-age cooldown of one
// whose setting npm-check-updates doesn't read itself (Bun's). Pure functions
// over file contents and names, so the tests need no files.

import { parse } from "smol-toml";
import { isRecord, parseManifest } from "./manifests.ts";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** A release-age cooldown: how old a release must be before it's installed. */
export interface Cooldown {
  minutes: number;
  /** Package names it doesn't apply to. */
  exclude: string[];
}

const PACKAGE_MANAGERS: readonly string[] = ["npm", "pnpm", "yarn", "bun"];

const isPackageManager = (name: string): name is PackageManager => PACKAGE_MANAGERS.includes(name);

// The files at the root that tell, in this order: each one's lockfiles, then
// the config files only one of them reads. Yarn 1 writes yarn.lock too, and
// .yarnrc.yml is Yarn 2 and later's.
const LOCKFILES: [file: string, packageManager: PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];
const CONFIG_FILES: [file: string, packageManager: PackageManager][] = [
  ["pnpm-workspace.yaml", "pnpm"],
  [".yarnrc.yml", "yarn"],
  ["bunfig.toml", "bun"],
];

/** The files `detectPackageManager` looks for at the root. */
export const MARKER_FILES: readonly string[] = [...LOCKFILES, ...CONFIG_FILES].map(
  ([file]) => file,
);

/**
 * The package manager a project uses: the one package.json's
 * `packageManager` names (as Corepack reads it, "pnpm@12.0.0"), else the
 * one whose lockfile, else config file, is at the root (`present`, out of
 * MARKER_FILES), else npm.
 */
export function detectPackageManager(
  rootManifest: string | undefined,
  present: ReadonlySet<string>,
): PackageManager {
  const field = parseManifest(rootManifest)["packageManager"];
  if (typeof field === "string") {
    const name = field.split("@", 1)[0] ?? "";
    if (isPackageManager(name)) return name;
  }
  for (const [file, packageManager] of [...LOCKFILES, ...CONFIG_FILES]) {
    if (present.has(file)) return packageManager;
  }
  return "npm";
}

/**
 * Bun's release-age cooldown, from bunfig.toml's `[install]` table:
 * `minimumReleaseAge` (seconds) and `minimumReleaseAgeExcludes` (package
 * names it doesn't apply to). Undefined when there's no file or setting;
 * throws if they aren't a number and a list of names.
 */
export function bunCooldown(bunfig: string | undefined): Cooldown | undefined {
  if (bunfig === undefined) return undefined;
  const install = parse(bunfig)["install"];
  if (!isRecord(install)) return undefined;
  const seconds = install["minimumReleaseAge"];
  if (seconds === undefined) return undefined;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error("install.minimumReleaseAge must be a number of seconds");
  }
  const exclude = install["minimumReleaseAgeExcludes"] ?? [];
  if (!Array.isArray(exclude) || !exclude.every((name) => typeof name === "string")) {
    throw new Error("install.minimumReleaseAgeExcludes must be a list of package names");
  }
  return { minutes: seconds / 60, exclude };
}

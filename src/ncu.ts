// Asks npm-check-updates for the newest release of some dependencies. It's
// run as its own command line, not through its module API, so it reads the
// registry settings (.npmrc) and the package manager's release-age cooldown
// (npm's min-release-age, pnpm's minimumReleaseAge) just as `ncu` does. It's
// given an empty config file of its own, so a project's .ncurc can't change
// what it does: latest-or-bust.json (config.ts) is latest-or-bust's config.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, type Specs } from "./manifests.ts";

/** Dependency name to the version spec npm-check-updates would upgrade it to. */
export type Upgrades = Map<string, string>;

function ncuCli(): string {
  const manifestPath = createRequire(import.meta.url).resolve("npm-check-updates/package.json");
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = isRecord(manifest) && isRecord(manifest["bin"]) ? manifest["bin"]["ncu"] : undefined;
  if (typeof bin !== "string") throw new Error(`No ncu command in ${manifestPath}`);
  return join(dirname(manifestPath), bin);
}

export interface NcuOptions {
  /** The repository root, where npm-check-updates runs. */
  root: string;
  /** "pnpm" to say it's a pnpm project; otherwise npm-check-updates works it out. */
  packageManager?: "pnpm";
}

/** What to ask about: dependencies of a package.json, or of a package's data. */
export interface NcuQuery {
  /** A package.json, relative to the root. */
  packageFile?: string;
  /** Dependency name to spec, checked as a package's dependencies. */
  dependencies?: Specs;
  names: string[];
  /** "minor" for the newest release on each one's current major. */
  target: "latest" | "minor";
}

// An empty config file, given explicitly so npm-check-updates doesn't look
// for one of the project's.
const EMPTY_CONFIG = fileURLToPath(new URL("../ncurc.empty.json", import.meta.url));

/**
 * Options set whatever npm-check-updates' defaults (or a future config
 * file) say, since they'd change what it does or prints: it must only look
 * (never rewrite a package file, install, prompt or run tests), answer for
 * just the package it's given, and print its upgrades as JSON with a zero
 * exit code.
 */
function pinnedOptions(root: string): string[] {
  return [
    "--configFileName",
    EMPTY_CONFIG,
    "--cwd",
    root,
    "--no-upgrade",
    "--no-doctor",
    "--no-interactive",
    "--no-global",
    "--no-deep",
    "--no-workspaces",
    "--no-jsonAll",
    "--no-jsonDeps",
    "--errorLevel",
    "1",
    "--jsonUpgraded",
  ];
}

/** Runs npm-check-updates and returns what it printed; its errors go straight to stderr. */
function ncuOutput(options: NcuOptions, args: string[]): Promise<string> {
  const child = spawn(process.execPath, [ncuCli(), ...args, ...pinnedOptions(options.root)], {
    cwd: options.root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(stdout);
      else {
        const status = signal === null ? `exit code ${String(code)}` : signal;
        reject(new Error(`npm-check-updates ${args.join(" ")} failed (${status}): ${stdout}`));
      }
    });
  });
}

async function runNcu(options: NcuOptions, args: string[]): Promise<unknown> {
  const stdout = await ncuOutput(options, args);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm-check-updates printed something other than JSON: ${stdout}`, {
      cause: error,
    });
  }
}

function upgradesOf(value: unknown): Upgrades {
  const upgrades: Upgrades = new Map();
  if (!isRecord(value)) return upgrades;
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === "string") upgrades.set(name, spec);
  }
  return upgrades;
}

/** The named dependencies that have a newer release (on their major, for target "minor"). */
export async function newerReleases(options: NcuOptions, query: NcuQuery): Promise<Upgrades> {
  if (query.names.length === 0) return new Map();
  const source =
    query.packageFile === undefined
      ? [
          "--packageData",
          JSON.stringify({ dependencies: Object.fromEntries(query.dependencies ?? []) }),
        ]
      : ["--packageFile", query.packageFile];
  return upgradesOf(
    await runNcu(options, [
      ...source,
      ...(options.packageManager === undefined ? [] : ["--packageManager", options.packageManager]),
      // The sections latest-or-bust compares.
      "--dep",
      "prod,dev,optional",
      "--target",
      query.target,
      "--filter",
      query.names.join(","),
    ]),
  );
}

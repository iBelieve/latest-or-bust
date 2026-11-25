// Asks npm-check-updates for the newest release of some dependencies. It's
// run as its own command line, not through its module API, so it reads the
// registry settings (.npmrc) and the package manager's release-age cooldown
// (npm's min-release-age, pnpm's minimumReleaseAge) just as `ncu` does. It's
// given a config file of its own, so a project's .ncurc can't change
// what it does: latest-or-bust.json (config.ts) is latest-or-bust's config.
// That config file, ncurc.mjs, also reports which packages it could look up.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, type Specs } from "./manifests.ts";

/** Dependency name to the version spec npm-check-updates would upgrade it to. */
export type Upgrades = Map<string, string>;

export interface Releases {
  /** The ones with a newer release (on their major, for target "minor"). */
  upgrades: Upgrades;
  /**
   * The ones it found no release of, sorted: not on the registry, or the
   * registry unreachable or refusing the login.
   */
  notFound: string[];
}

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

// latest-or-bust's config file for it, given explicitly so npm-check-updates
// doesn't look for one of the project's.
const CONFIG = fileURLToPath(new URL("../ncurc.mjs", import.meta.url));

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
    CONFIG,
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

interface Output {
  stdout: string;
  /** What ncurc.mjs wrote: a JSON string per line, each a package it found a release of. */
  found: string;
}

/** Runs npm-check-updates and returns what it printed; its errors go straight to stderr. */
function ncuOutput(options: NcuOptions, args: string[]): Promise<Output> {
  const child = spawn(process.execPath, [ncuCli(), ...args, ...pinnedOptions(options.root)], {
    cwd: options.root,
    // File descriptor 3 is where ncurc.mjs names the packages it found.
    stdio: ["ignore", "pipe", "inherit", "pipe"],
  });
  const [, out, , foundPipe] = child.stdio;
  if (!(out instanceof Readable) || !(foundPipe instanceof Readable)) {
    throw new Error("npm-check-updates has no output pipes");
  }
  let stdout = "";
  let found = "";
  out.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  foundPipe.setEncoding("utf8").on("data", (chunk: string) => (found += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout, found });
      else {
        const status = signal === null ? `exit code ${String(code)}` : signal;
        const printed = stdout.trim() === "" ? "see its errors above" : stdout.trim();
        reject(new Error(`npm-check-updates ${args.join(" ")} failed (${status}): ${printed}`));
      }
    });
  });
}

function parseJson(what: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} isn't JSON: ${text}`, { cause: error });
  }
}

function foundNames(found: string): Set<string> {
  const names = new Set<string>();
  for (const line of found.split("\n")) {
    if (line === "") continue;
    const name = parseJson("A package name from ncurc.mjs", line);
    if (typeof name === "string") names.add(name);
  }
  return names;
}

function upgradesOf(value: unknown): Upgrades {
  const upgrades: Upgrades = new Map();
  if (!isRecord(value)) return upgrades;
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === "string") upgrades.set(name, spec);
  }
  return upgrades;
}

/** Which of the named dependencies have a newer release (on their major, for target "minor"), and which have none at all. */
export async function newerReleases(options: NcuOptions, query: NcuQuery): Promise<Releases> {
  if (query.names.length === 0) return { upgrades: new Map(), notFound: [] };
  const source =
    query.packageFile === undefined
      ? [
          "--packageData",
          JSON.stringify({ dependencies: Object.fromEntries(query.dependencies ?? []) }),
        ]
      : ["--packageFile", query.packageFile];
  const ask = (names: string[], extra: string[] = []): Promise<Output> =>
    ncuOutput(options, [
      ...source,
      ...(options.packageManager === undefined ? [] : ["--packageManager", options.packageManager]),
      // The sections latest-or-bust compares.
      "--dep",
      "prod,dev,optional",
      "--target",
      query.target,
      "--filter",
      names.join(","),
      ...extra,
    ]);
  const { stdout, found } = await ask(query.names);
  const upgrades = upgradesOf(parseJson("What npm-check-updates printed", stdout));
  const seen = foundNames(found);
  let missing = query.names.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    // filterResults isn't called either for a package whose newer releases
    // are all in the cooldown, so it stays where it is. Without the
    // cooldown, npm-check-updates finds a release of those.
    const again = foundNames((await ask(missing, ["--cooldown", "0"])).found);
    missing = missing.filter((name) => !again.has(name));
  }
  return { upgrades, notFound: missing.toSorted() };
}

// Asks npm-check-updates for the newest release of some dependencies. It's
// run as its own command line, not through its module API, so it reads its
// config file (.ncurc and friends, for `reject`) and the package manager's
// release-age cooldown (pnpm's minimumReleaseAge) just as `ncu` does.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
  /** The repository root: npm-check-updates runs there and reads its config file from there. */
  root: string;
}

/**
 * Options set whatever the config file says, since they'd change what
 * npm-check-updates does or prints: it must only look (never rewrite a
 * package file, install, prompt or run tests), answer for just the package
 * it's given, and print its upgrades as JSON with a zero exit code. The
 * command line's options win over the config file's.
 */
function pinnedOptions(root: string): string[] {
  return [
    "--configFilePath",
    root,
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

/** The named dependencies in one package.json (relative to the root) that have a newer release. */
export async function manifestUpgrades(
  options: NcuOptions,
  manifest: string,
  names: string[],
): Promise<Upgrades> {
  return upgradesOf(
    await runNcu(options, [
      "--packageFile",
      manifest,
      // The sections latest-or-bust compares, whatever the config file says.
      "--dep",
      "prod,dev,optional",
      "--filter",
      names.join(","),
    ]),
  );
}

/**
 * The entries of one pnpm catalog (name to spec) that have a newer release.
 * npm-check-updates' --workspaces merges every catalog into one list by
 * package name, so a name in two catalogs would be judged by only one of its
 * specs, and it needs pnpm-lock.yaml to know to read them. So it's handed
 * one catalog's entries as a package of its own, as pnpm (for the
 * cooldown), instead.
 */
export async function catalogUpgrades(options: NcuOptions, entries: Specs): Promise<Upgrades> {
  return upgradesOf(
    await runNcu(options, [
      "--packageData",
      JSON.stringify({ dependencies: Object.fromEntries(entries) }),
      "--packageManager",
      "pnpm",
      "--dep",
      "prod",
      "--filter",
      [...entries.keys()].join(","),
    ]),
  );
}

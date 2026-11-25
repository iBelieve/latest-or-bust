// Asks npm-check-updates for the newest release of some dependencies. It's
// run as its own command line, not through its module API, so it reads its
// config file (.ncurc and friends, for `reject`) and the package manager's
// release-age cooldown (pnpm's minimumReleaseAge) just as `ncu` does.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isRecord } from "./manifests.ts";

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

/** Runs npm-check-updates and returns what it printed; its errors go straight to stderr. */
function ncuOutput(options: NcuOptions, args: string[]): Promise<string> {
  const child = spawn(
    process.execPath,
    [ncuCli(), ...args, "--configFilePath", options.root, "--jsonUpgraded"],
    { cwd: options.root, stdio: ["ignore", "pipe", "inherit"] },
  );
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
    await runNcu(options, ["--packageFile", manifest, "--filter", names.join(",")]),
  );
}

/**
 * The named entries in pnpm-workspace.yaml's catalogs that have a newer
 * release. npm-check-updates reaches the catalogs only through --workspaces,
 * which also checks each package.json for these names, so only its results
 * for pnpm-workspace.yaml count: a package's own pin of the same name isn't
 * what changed.
 */
export async function catalogUpgrades(options: NcuOptions, names: string[]): Promise<Upgrades> {
  const result = await runNcu(options, ["--workspaces", "--filter", names.join(",")]);
  return upgradesOf(isRecord(result) ? result["pnpm-workspace.yaml"] : undefined);
}

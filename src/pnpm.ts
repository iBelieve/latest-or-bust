// pnpm 11 and later wait a day before installing a new release even when
// nothing sets minimumReleaseAge: its default is 1440 minutes. But
// npm-check-updates only applies a minimumReleaseAge that's set, in
// pnpm-workspace.yaml or pnpm's global config.yaml, so without one it would
// ask for a release pnpm won't install yet. When nothing sets it, then,
// latest-or-bust points npm-check-updates' XDG_CONFIG_HOME at a copy of pnpm's
// global config that sets the default. That way npm-check-updates still reads
// minimumReleaseAgeExclude and the registries as it otherwise would, which
// passing it --cooldown wouldn't do.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { isRecord } from "./manifests.ts";

/** pnpm's default minimumReleaseAge, in minutes, since pnpm 11. */
export const DEFAULT_MINIMUM_RELEASE_AGE = 1440;

/** Where pnpm, and npm-check-updates, find pnpm's global config.yaml. */
export function pnpmConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") return join(xdg, "pnpm");
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    return join(
      local !== undefined && local !== "" ? local : join(home, "AppData", "Local"),
      "pnpm",
      "config",
    );
  }
  if (platform === "darwin") return join(home, "Library", "Preferences", "pnpm");
  return join(home, ".config", "pnpm");
}

/** A YAML file's top level, or {} if it's missing or isn't a YAML mapping (as npm-check-updates treats it). */
function readYaml(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    const value: unknown = parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function readFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Whether a pnpm config sets minimumReleaseAge, under either of the names npm-check-updates reads. */
function setsMinimumReleaseAge(config: Record<string, unknown>): boolean {
  const value = config["minimumReleaseAge"] ?? config["minimum-release-age"];
  return value !== undefined && value !== null;
}

/** The major version in package.json's packageManager, if it names pnpm. */
function declaredMajor(rootManifest: string | undefined): number | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(rootManifest ?? "{}");
  } catch {
    return undefined;
  }
  const field = isRecord(manifest) ? manifest["packageManager"] : undefined;
  const match = typeof field === "string" ? /^pnpm@(\d+)\./.exec(field) : null;
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** The major version `pnpm --version` prints in the root, if pnpm runs there. */
async function installedMajor(root: string): Promise<number | undefined> {
  try {
    const { stdout } = await promisify(execFile)("pnpm", ["--version"], {
      cwd: root,
      encoding: "utf8",
      // pnpm.cmd, on Windows, only runs in a shell.
      shell: process.platform === "win32",
    });
    const major = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(major) ? undefined : major;
  } catch {
    return undefined;
  }
}

/**
 * For a pnpm project where pnpm applies its default minimumReleaseAge, a new
 * directory to give npm-check-updates as XDG_CONFIG_HOME: its pnpm/config.yaml
 * is pnpm's global config with minimumReleaseAge set to the default. The
 * caller removes it. Undefined when pnpm-workspace.yaml or the global config
 * sets minimumReleaseAge, or pnpm is older than 11. pnpm's version comes from
 * package.json's packageManager, else `pnpm --version`; if neither says, it's
 * taken to be 11 or later.
 */
export async function defaultCooldownConfig(
  root: string,
  rootManifest: string | undefined,
  workspace: string | undefined,
): Promise<string | undefined> {
  if (setsMinimumReleaseAge(readYaml(workspace))) return undefined;
  const global = readYaml(readFile(join(pnpmConfigDir(), "config.yaml")));
  if (setsMinimumReleaseAge(global)) return undefined;
  const major = declaredMajor(rootManifest) ?? (await installedMajor(root));
  if (major !== undefined && major < 11) return undefined;
  const home = mkdtempSync(join(tmpdir(), "latest-or-bust-pnpm-"));
  mkdirSync(join(home, "pnpm"));
  writeFileSync(
    join(home, "pnpm", "config.yaml"),
    stringify({ ...global, minimumReleaseAge: DEFAULT_MINIMUM_RELEASE_AGE }),
  );
  return home;
}

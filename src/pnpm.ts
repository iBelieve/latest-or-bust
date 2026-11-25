// pnpm 11 and later wait a day before installing a new release even when
// nothing sets minimumReleaseAge: its default is 1440 minutes. But
// npm-check-updates only applies a minimumReleaseAge that's set, in
// pnpm-workspace.yaml or pnpm's global config.yaml, so without one it would
// ask for a release pnpm won't install yet. When nothing sets it, then,
// latest-or-bust points npm-check-updates' XDG_CONFIG_HOME at a copy of pnpm's
// global config that sets the default (or what PNPM_CONFIG_MINIMUM_RELEASE_AGE
// says, which npm-check-updates doesn't read either). That way it still reads
// minimumReleaseAgeExclude and the registries as it otherwise would, which
// passing it --cooldown wouldn't do.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * minimumReleaseAge from pnpm's PNPM_CONFIG_MINIMUM_RELEASE_AGE environment
 * variable, which pnpm reads and npm-check-updates doesn't; undefined if
 * it isn't set to a number of minutes.
 */
function envMinimumReleaseAge(env: NodeJS.ProcessEnv): number | undefined {
  const value = env["PNPM_CONFIG_MINIMUM_RELEASE_AGE"] ?? env["pnpm_config_minimum_release_age"];
  if (value === undefined || value.trim() === "") return undefined;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : undefined;
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
  const windows = process.platform === "win32";
  try {
    const { stdout } = await promisify(execFile)("pnpm", ["--version"], {
      cwd: root,
      encoding: "utf8",
      // pnpm.cmd, on Windows, only runs in a shell. cmd.exe looks in the
      // current directory before PATH unless told not to, and a pnpm.cmd in
      // the repository being checked mustn't run.
      shell: windows,
      ...(windows ? { env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" } } : {}),
    });
    const major = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(major) ? undefined : major;
  } catch {
    return undefined;
  }
}

/**
 * For a pnpm project where pnpm applies its default minimumReleaseAge, or
 * the one PNPM_CONFIG_MINIMUM_RELEASE_AGE sets, a new directory to give
 * npm-check-updates as XDG_CONFIG_HOME: its pnpm/config.yaml is pnpm's global
 * config with minimumReleaseAge set to that. The caller removes it. Undefined
 * when pnpm-workspace.yaml sets minimumReleaseAge, the global config does and
 * the environment doesn't, or pnpm is older than 11. pnpm's version comes from
 * package.json's packageManager, else `pnpm --version`; if neither says, it's
 * taken to be 11 or later.
 */
export async function defaultCooldownConfig(
  root: string,
  rootManifest: string | undefined,
  workspace: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (setsMinimumReleaseAge(readYaml(workspace))) return undefined;
  const global = readYaml(readFile(join(pnpmConfigDir(env), "config.yaml")));
  const fromEnv = envMinimumReleaseAge(env);
  if (fromEnv === undefined && setsMinimumReleaseAge(global)) return undefined;
  const major = declaredMajor(rootManifest) ?? (await installedMajor(root));
  if (major !== undefined && major < 11) return undefined;
  const home = mkdtempSync(join(tmpdir(), "latest-or-bust-pnpm-"));
  try {
    mkdirSync(join(home, "pnpm"));
    writeFileSync(
      join(home, "pnpm", "config.yaml"),
      stringify({ ...global, minimumReleaseAge: fromEnv ?? DEFAULT_MINIMUM_RELEASE_AGE }),
    );
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return home;
}

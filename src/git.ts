// The git side: the repository root, the base revision to compare with, and
// files at that revision or in the working tree.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  // Git didn't run at all (it isn't installed, say): that's no answer, so
  // don't pass it off as "not a repository" or "no such revision".
  if (result.error !== undefined) throw result.error;
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The top of the working tree that `cwd` is in. */
export function repositoryRoot(cwd: string): string {
  const root = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === undefined) throw new Error(`${cwd} isn't in a git repository`);
  return root;
}

/** Resolves `revision` to a commit, or fails: an unknown base must not make every dependency look new. */
export function resolveCommit(root: string, revision: string): string {
  const commit = tryGit(root, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  if (commit === undefined) {
    throw new Error(`Unknown base revision ${revision} (in a shallow clone, fetch it first)`);
  }
  return commit;
}

/**
 * The default base: where HEAD branched from the remote's default branch
 * (origin/HEAD, else origin/main or origin/master).
 */
export function defaultBase(root: string): string {
  const candidates = [
    tryGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    "origin/main",
    "origin/master",
  ];
  for (const branch of candidates) {
    if (branch === undefined) continue;
    const base = tryGit(root, ["merge-base", branch, "HEAD"]);
    if (base !== undefined) return base;
  }
  throw new Error(
    "Can't find where HEAD branched from origin's default branch; pass the base revision to compare with",
  );
}

/** A file's contents at `commit`, or undefined if it didn't exist there. */
export function atRevision(root: string, commit: string, path: string): string | undefined {
  if (tryGit(root, ["cat-file", "-e", `${commit}:${path}`]) === undefined) return undefined;
  return git(root, ["show", `${commit}:${path}`]);
}

/** A file's contents in the working tree, or undefined if it doesn't exist. */
export function inWorkingTree(root: string, path: string): string | undefined {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/**
 * The directories, other than the root, holding a package.json that git
 * tracks or would track (untracked but not ignored), with forward slashes,
 * leaving out node_modules.
 */
export function packageDirectories(root: string): string[] {
  const files = git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "*/package.json",
    // Left out by git, not after: in a repository that doesn't ignore
    // node_modules, their package.json files could overflow the output buffer.
    ":(exclude,glob)**/node_modules/**",
  ]);
  const dirs = new Set<string>();
  for (const file of files.split("\0")) {
    if (posix.basename(file) === "package.json") dirs.add(posix.dirname(file));
  }
  return [...dirs];
}

// Test helpers: a throwaway git repository, and a fake npm registry for
// npm-check-updates to ask, so the tests don't depend on what's on npm today.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DAY = 24 * 60 * 60 * 1000;

/** A package's releases, oldest first, as [version, days ago it was published]. */
export type Releases = [version: string, daysAgo: number][];

export interface Registry {
  url: string;
  close(): Promise<void>;
}

function packument(name: string, releases: Releases): object {
  const time: Record<string, string> = {};
  const versions: Record<string, object> = {};
  for (const [version, daysAgo] of releases) {
    time[version] = new Date(Date.now() - daysAgo * DAY).toISOString();
    versions[version] = {
      name,
      version,
      dist: { tarball: `https://example.invalid/${name}-${version}.tgz` },
    };
  }
  const latest = releases.at(-1)?.[0];
  return { name, "dist-tags": latest === undefined ? {} : { latest }, versions, time };
}

/** Serves each package's packument at /<name>, and 404s anything else. */
export async function startRegistry(packages: Record<string, Releases>): Promise<Registry> {
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "/").slice(1).split("?")[0] ?? "");
    const releases = packages[name];
    if (releases === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(packument(name, releases)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port to listen on");
  const { port } = address;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

export interface Repository {
  root: string;
  /** Writes files (path to contents; objects as JSON), relative to the root. */
  write(files: Record<string, string | object>): void;
  /** Commits everything and returns the commit. */
  commit(): string;
  git(...args: string[]): string;
  remove(): void;
}

export function createRepository(): Repository {
  const root = mkdtempSync(join(tmpdir(), "latest-or-bust-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  return {
    root,
    git,
    write(files) {
      for (const [path, contents] of Object.entries(files)) {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`,
        );
      }
    },
    commit() {
      git("add", "--all");
      git("commit", "--quiet", "--allow-empty", "--message", "commit");
      return git("rev-parse", "HEAD");
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

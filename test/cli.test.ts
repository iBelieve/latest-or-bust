// The command line: arguments, the default base, the report and exit codes.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isRecord } from "../src/manifests.ts";
import { createRepository, startRegistry, type Registry, type Repository } from "./fixtures.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the command asynchronously, so this process's fake registry can answer it. */
function cli(cwd: string, ...args: string[]): Promise<Run> {
  const child = spawn(process.execPath, [CLI, ...args], { cwd });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let registry: Registry;
let repo: Repository;

before(async () => {
  registry = await startRegistry({
    foo: [
      ["1.0.0", 30],
      ["1.1.0", 20],
    ],
  });
});

after(() => registry.close());

beforeEach(() => {
  repo = createRepository();
  repo.write({ ".npmrc": `registry=${registry.url}\n`, "package-lock.json": "{}\n" });
});

afterEach(() => repo.remove());

describe("latest-or-bust", () => {
  it("prints help", async () => {
    const run = await cli(repo.root, "--help");
    assert.equal(run.code, 0);
    assert.match(run.stdout, /^Usage: latest-or-bust \[base revision\]/);
  });

  it("prints its version", async () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.ok(isRecord(manifest));
    const run = await cli(repo.root, "--version");
    assert.equal(run.code, 0);
    assert.equal(run.stdout.trim(), manifest["version"]);
  });

  it("refuses unknown options and extra arguments", async () => {
    for (const args of [["--nope"], ["HEAD", "HEAD"]]) {
      const run = await cli(repo.root, ...args);
      assert.equal(run.code, 1);
      assert.match(run.stderr, /^Usage:/);
    }
  });

  it("fails outside a git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latest-or-bust-"));
    try {
      const run = await cli(dir, "HEAD");
      assert.equal(run.code, 1);
      assert.match(run.stderr, /isn't in a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on an unknown base", async () => {
    repo.commit();
    const run = await cli(repo.root, "nope");
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Unknown base revision nope/);
  });

  it("needs a base when there's no origin to branch from", async () => {
    repo.commit();
    const run = await cli(repo.root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /pass the base revision/);
  });

  it("compares with where HEAD branched from origin by default", async () => {
    repo.write({ "package.json": { dependencies: { foo: "1.0.0" } } });
    const base = repo.commit();
    repo.git("update-ref", "refs/remotes/origin/main", base);
    repo.write({ "package.json": { dependencies: { foo: "1.1.0" } } });
    repo.commit();
    const run = await cli(repo.root);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`since ${base}\n`));
    assert.match(run.stdout, /package\.json: foo\n\nAll of them are the newest release/);
  });

  it("reports nothing changed", async () => {
    repo.write({ "package.json": { dependencies: { foo: "1.0.0" } } });
    const base = repo.commit();
    const run = await cli(repo.root, base);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /No dependencies were added or changed/);
  });

  it("fails, listing each dependency that isn't the newest release", async () => {
    repo.write({ "package.json": {} });
    repo.commit();
    repo.write({ "package.json": { dependencies: { foo: "^1.0.0" } } });
    const run = await cli(repo.root, "HEAD");
    assert.equal(run.code, 1);
    assert.match(run.stdout, /since HEAD \([0-9a-f]{40}\)\npackage\.json: foo\n/);
    assert.match(
      run.stderr,
      /Not the newest release:\n {2}package\.json {2}foo {2}\^1\.0\.0 → \^1\.1\.0\n/,
    );
    assert.match(run.stderr, /exempt it in latest-or-bust\.json with the reason why/);
  });

  it("lists exemptions, and says it doesn't read .ncurc", async () => {
    repo.write({ "package.json": {} });
    repo.commit();
    repo.write({
      ".ncurc.cjs": "module.exports = { reject: ['foo'] };\n",
      "latest-or-bust.json": { exempt: { foo: { reason: "foo 1.1 breaks us" } } },
      "package.json": { dependencies: { foo: "1.0.0" } },
    });
    const run = await cli(repo.root, "HEAD");
    assert.equal(run.code, 0, run.stderr);
    assert.match(
      run.stderr,
      /doesn't read \.ncurc\.cjs; it takes its exemptions from latest-or-bust\.json/,
    );
    assert.match(
      run.stdout,
      /Exempt in latest-or-bust\.json:\n {2}package\.json {2}foo {2}\(not checked: foo 1\.1 breaks us\)\n/,
    );
  });
});

// The command line: arguments, the default base, the report and exit codes.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Runs the command asynchronously, so this process's fake registry can answer
 * it; outside GitHub Actions, even when the tests run there, unless `github`
 * says otherwise.
 */
function cli(cwd: string, args: string[], github: Record<string, string> = {}): Promise<Run> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GITHUB_")),
  );
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...github } });
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
    bar: [["1.0.0", 30]],
    baz: [
      ["1.0.0", 30],
      ["1.1.0", 20],
      ["2.0.0", 10],
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
    const run = await cli(repo.root, ["--help"]);
    assert.equal(run.code, 0);
    assert.match(run.stdout, /^Usage: latest-or-bust \[base revision\]/);
  });

  it("prints its version", async () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.ok(isRecord(manifest));
    const run = await cli(repo.root, ["--version"]);
    assert.equal(run.code, 0);
    assert.equal(run.stdout.trim(), manifest["version"]);
  });

  it("refuses unknown options and extra arguments", async () => {
    for (const args of [["--nope"], ["HEAD", "HEAD"]]) {
      const run = await cli(repo.root, args);
      assert.equal(run.code, 1);
      assert.match(run.stderr, /^Usage:/);
    }
  });

  it("fails outside a git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latest-or-bust-"));
    try {
      const run = await cli(dir, ["HEAD"]);
      assert.equal(run.code, 1);
      assert.match(run.stderr, /isn't in a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on an unknown base", async () => {
    repo.commit();
    const run = await cli(repo.root, ["nope"]);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Unknown base revision nope/);
  });

  it("needs a base when there's no origin to branch from", async () => {
    repo.commit();
    const run = await cli(repo.root, []);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /pass the base revision/);
  });

  it("compares with where HEAD branched from origin by default", async () => {
    repo.write({ "package.json": { dependencies: { foo: "1.0.0" } } });
    const base = repo.commit();
    repo.git("update-ref", "refs/remotes/origin/main", base);
    repo.write({ "package.json": { dependencies: { foo: "1.1.0" } } });
    repo.commit();
    const run = await cli(repo.root, []);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`since ${base}\n`));
    assert.match(run.stdout, /package\.json: foo\n\nAll of them are the newest release/);
  });

  it("reports nothing changed", async () => {
    repo.write({ "package.json": { dependencies: { foo: "1.0.0" } } });
    const base = repo.commit();
    const run = await cli(repo.root, [base]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /No dependencies were added or changed/);
  });

  it("fails, listing each dependency that isn't the newest release", async () => {
    repo.write({ "package.json": {} });
    repo.commit();
    repo.write({ "package.json": { dependencies: { foo: "^1.0.0" } } });
    const run = await cli(repo.root, ["HEAD"]);
    assert.equal(run.code, 1);
    assert.match(run.stdout, /since HEAD \([0-9a-f]{40}\)\npackage\.json: foo\n/);
    assert.match(
      run.stderr,
      /Not the newest release:\n {2}package\.json {2}foo {2}\^1\.0\.0 → \^1\.1\.0\n/,
    );
    assert.match(run.stderr, /exempt it in latest-or-bust\.json with the reason why/);
  });

  it("names the section of a dependency that's in more than one", async () => {
    repo.write({ "package.json": {} });
    repo.commit();
    repo.write({
      "package.json": { dependencies: { foo: "1.0.0" }, devDependencies: { foo: "1.1.0" } },
    });
    const run = await cli(repo.root, ["HEAD"]);
    assert.equal(run.code, 1);
    assert.match(run.stdout, /\npackage\.json: foo\n/);
    assert.match(
      run.stderr,
      /Not the newest release:\n {2}package\.json \(dependencies\) {2}foo {2}1\.0\.0 → 1\.1\.0\n\n/,
    );
  });

  it("fails, listing each dependency it finds no release of", async () => {
    repo.write({ "package.json": { dependencies: {} } });
    repo.commit();
    repo.write({ "package.json": { dependencies: { foo: "1.1.0", nope: "^1.0.0" } } });
    const run = await cli(repo.root, ["HEAD"]);
    assert.equal(run.code, 1);
    assert.match(
      run.stderr,
      /No release found \(not on the registry.*\):\n {2}package\.json {2}nope {2}\^1\.0\.0\n/,
    );
    assert.doesNotMatch(run.stderr, /Not the newest release/);
  });

  it("lists exemptions, and says it doesn't read .ncurc", async () => {
    repo.write({ "package.json": {} });
    repo.commit();
    repo.write({
      ".ncurc.cjs": "module.exports = { reject: ['foo'] };\n",
      "latest-or-bust.json": { exempt: { foo: { reason: "foo 1.1 breaks us" } } },
      "package.json": { dependencies: { foo: "1.0.0" } },
    });
    const run = await cli(repo.root, ["HEAD"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(
      run.stderr,
      /doesn't read \.ncurc\.cjs; it takes its exemptions from latest-or-bust\.json/,
    );
    assert.match(
      run.stdout,
      /Exempt in latest-or-bust\.json:\n {2}package\.json {2}foo {2}\(not checked: foo 1\.1 breaks us\)\n/,
    );
    assert.match(run.stdout, /Nothing to check: latest-or-bust\.json exempts all of them\./);
  });

  it("holds a dependency allowed to stay on its major to the newest release there", async () => {
    repo.write({
      "package.json": {},
      "latest-or-bust.json": {
        exempt: { baz: { reason: "baz 2 drops Node.js 22", allow: "minor" } },
      },
    });
    repo.commit();
    repo.write({ "package.json": { dependencies: { baz: "^1.1.0" } } });
    const passed = await cli(repo.root, ["HEAD"]);
    assert.equal(passed.code, 0, passed.stderr);
    assert.match(
      passed.stdout,
      /\n {2}package\.json {2}baz {2}\(newest on its major: baz 2 drops Node\.js 22\)\n/,
    );
    assert.match(passed.stdout, /All of them are the newest release\./);
    assert.equal(passed.stderr, "");

    repo.write({ "package.json": { dependencies: { baz: "^1.0.0" } } });
    const failed = await cli(repo.root, ["HEAD"]);
    assert.equal(failed.code, 1);
    assert.match(
      failed.stderr,
      /\n {2}package\.json {2}baz {2}\^1\.0\.0 → \^1\.1\.0 \(the newest on its major, as latest-or-bust\.json allows\)\n/,
    );
    assert.doesNotMatch(failed.stderr, /No release found/);
  });

  it("says all are exempt when two different dependencies are", async () => {
    repo.write({ "package.json": {} });
    repo.commit();
    repo.write({
      "latest-or-bust.json": {
        exempt: { foo: { reason: "testing" }, bar: { reason: "testing" } },
      },
      "package.json": { dependencies: { foo: "1.0.0", bar: "1.0.0" } },
    });
    const run = await cli(repo.root, ["HEAD"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Nothing to check: latest-or-bust\.json exempts all of them\./);
  });

  it("doesn't say all are exempt when one is exempt in two sections and another isn't", async () => {
    repo.write({ "package.json": {} });
    repo.commit();
    repo.write({
      "latest-or-bust.json": { exempt: { foo: { reason: "testing" } } },
      "package.json": {
        dependencies: { foo: "1.0.0", bar: "1.0.0" },
        devDependencies: { foo: "1.0.0" },
      },
    });
    const run = await cli(repo.root, ["HEAD"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /All of them are the newest release\./);
  });

  describe("on GitHub Actions", () => {
    let events: string;
    beforeEach(() => (events = mkdtempSync(join(tmpdir(), "latest-or-bust-"))));
    afterEach(() => rmSync(events, { recursive: true, force: true }));

    function github(event: string, payload: object = {}): Record<string, string> {
      const path = join(events, "event.json");
      writeFileSync(path, JSON.stringify(payload));
      return {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: event,
        GITHUB_EVENT_PATH: path,
        GITHUB_SHA: repo.git("rev-parse", "HEAD"),
      };
    }

    it("passes a run that isn't for a pull request, with nothing to check", async () => {
      repo.write({ "package.json": { dependencies: { foo: "1.0.0" } } });
      repo.commit();
      const run = await cli(repo.root, [], github("push"));
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /^Not a pull request \(this is a GitHub Actions push run\)/);
      assert.doesNotMatch(run.stdout, /Checking/);
    });

    it("checks against a base revision it's passed regardless", async () => {
      repo.write({ "package.json": {} });
      repo.commit();
      repo.write({ "package.json": { dependencies: { foo: "1.0.0" } } });
      repo.commit();
      const run = await cli(repo.root, ["HEAD^"], github("push"));
      assert.equal(run.code, 1);
      assert.match(run.stderr, /package\.json {2}foo {2}1\.0\.0 → 1\.1\.0/);
    });

    it("checks a pull request's merge against its base", async () => {
      repo.write({ "package.json": {} });
      const base = repo.commit();
      repo.git("checkout", "--quiet", "-b", "feature");
      repo.write({ "package.json": { dependencies: { foo: "1.0.0" } } });
      const head = repo.commit();
      repo.git("checkout", "--quiet", "--detach", base);
      repo.git("merge", "--quiet", "--no-ff", "--message", "Merge", "feature");
      const payload = {
        pull_request: {
          number: 7,
          user: { login: "someone" },
          base: { ref: "main", sha: base },
          head: { sha: head },
        },
      };
      const run = await cli(repo.root, [], github("pull_request", payload));
      assert.equal(run.code, 1);
      assert.match(run.stdout, new RegExp(`since main, pull request #7's base \\(${base}\\)\n`));
      assert.match(run.stderr, /package\.json {2}foo {2}1\.0\.0 → 1\.1\.0/);
    });
  });
});

// End to end through git and npm-check-updates, against a fake registry.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, afterEach, describe, it } from "node:test";
import { check, type CheckResult } from "../src/check.ts";
import { createRepository, startRegistry, type Registry, type Repository } from "./fixtures.ts";

let registry: Registry;
let repo: Repository;

before(async () => {
  registry = await startRegistry({
    // The newest, 1.3.0, is younger than the 1-day cooldowns below.
    foo: [
      ["1.0.0", 30],
      ["1.1.0", 20],
      ["1.2.0", 10],
      ["1.3.0", 0.1],
    ],
    "@scope/bar": [
      ["1.0.0", 30],
      ["2.0.0", 5],
    ],
    baz: [["3.0.0", 5]],
  });
});

after(() => registry.close());

beforeEach(() => {
  repo = createRepository();
});

afterEach(() => repo.remove());

/** An npm project: package-lock.json makes npm-check-updates read .npmrc's min-release-age. */
function npmProject(manifest: object, files: Record<string, string | object> = {}): void {
  repo.write({
    ".npmrc": `registry=${registry.url}\nmin-release-age=1\n`,
    "package-lock.json": "{}\n",
    "package.json": manifest,
    ...files,
  });
}

/** A pnpm project: pnpm-lock.yaml makes npm-check-updates read minimumReleaseAge. */
function pnpmProject(workspace: string, files: Record<string, string | object> = {}): void {
  repo.write({
    ".npmrc": `registry=${registry.url}\n`,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": `minimumReleaseAge: 1440\n${workspace}`,
    "package.json": { name: "root" },
    ...files,
  });
}

const run = (base: string): Promise<CheckResult> => check({ root: repo.root, base });

/** The outdated dependencies, as "file name spec → latest". */
const outdated = (result: CheckResult): string[] =>
  result.outdated.map(({ file, name, spec, latest }) => `${file} ${name} ${spec} → ${latest}`);

describe("check", () => {
  it("passes, without asking the registry, when no dependency changed", async () => {
    npmProject({ dependencies: { foo: "1.0.0" } });
    const base = repo.commit();
    repo.write({ "package.json": { name: "renamed", dependencies: { foo: "1.0.0" } } });
    const result = await run(base);
    assert.equal(result.checked.size, 0);
    assert.deepEqual(result.outdated, []);
  });

  it("flags an added dependency that isn't the newest release", async () => {
    npmProject({ dependencies: {} });
    const base = repo.commit();
    npmProject({ dependencies: { "@scope/bar": "^1.0.0" } });
    const result = await run(base);
    assert.deepEqual(result.checked, new Map([["package.json", ["@scope/bar"]]]));
    assert.deepEqual(outdated(result), ["package.json @scope/bar ^1.0.0 → ^2.0.0"]);
  });

  it("flags an upgrade that stops short of the newest release", async () => {
    npmProject({ dependencies: { foo: "1.0.0" } });
    const base = repo.commit();
    npmProject({ dependencies: { foo: "1.1.0" } });
    assert.deepEqual(outdated(await run(base)), ["package.json foo 1.1.0 → 1.2.0"]);
  });

  it("flags a range whose floor isn't the newest release", async () => {
    npmProject({ dependencies: { foo: "^1.0.0" } });
    const base = repo.commit();
    npmProject({ dependencies: { foo: "^1.1.0" } });
    assert.deepEqual(outdated(await run(base)), ["package.json foo ^1.1.0 → ^1.2.0"]);
  });

  it("passes an upgrade to the newest release the cooldown allows", async () => {
    npmProject({ dependencies: { foo: "1.0.0" } });
    const base = repo.commit();
    npmProject({ devDependencies: { foo: "1.2.0" } });
    const result = await run(base);
    assert.deepEqual(result.checked, new Map([["package.json", ["foo"]]]));
    assert.deepEqual(result.outdated, []);
  });

  it("leaves alone outdated dependencies the change didn't touch", async () => {
    npmProject({ dependencies: { foo: "1.0.0", "@scope/bar": "1.0.0" } });
    const base = repo.commit();
    npmProject({ dependencies: { foo: "1.0.0", "@scope/bar": "2.0.0" } });
    const result = await run(base);
    assert.deepEqual(result.checked, new Map([["package.json", ["@scope/bar"]]]));
    assert.deepEqual(result.outdated, []);
  });

  it("skips what latest-or-bust.json exempts, in every package and catalog", async () => {
    pnpmProject("packages:\n  - 'packages/*'\n");
    const base = repo.commit();
    pnpmProject("packages:\n  - 'packages/*'\ncatalog:\n  foo: 1.0.0\n", {
      "latest-or-bust.json": { exempt: { foo: { reason: "foo 1.2 breaks us" } } },
      "package.json": { name: "root", dependencies: { foo: "1.0.0" } },
      "packages/a/package.json": { dependencies: { foo: "1.1.0", baz: "3.0.0" } },
    });
    const result = await run(base);
    assert.deepEqual(
      result.checked,
      new Map([
        ["package.json", ["foo"]],
        ["packages/a/package.json", ["baz", "foo"]],
        ["pnpm-workspace.yaml", ["foo"]],
      ]),
    );
    const reason = "foo 1.2 breaks us";
    assert.deepEqual(result.exempted, [
      { file: "package.json", name: "foo", reason },
      { file: "packages/a/package.json", name: "foo", reason },
      { file: "pnpm-workspace.yaml", name: "foo", reason },
    ]);
    assert.deepEqual(result.outdated, []);
  });

  it('wants the newest release on the major for "allow": "minor"', async () => {
    const config = {
      exempt: {
        "@scope/bar": { reason: "bar 2 drops Node.js 22", allow: "minor" },
        foo: { reason: "foo 2 isn't out, so this changes nothing", allow: "minor" },
      },
    };
    npmProject({ dependencies: {} });
    const base = repo.commit();
    npmProject(
      { dependencies: { "@scope/bar": "^1.0.0", foo: "1.1.0" } },
      { "latest-or-bust.json": config },
    );
    const result = await run(base);
    // @scope/bar's 2.0.0 is out, but 1.0.0 is the newest 1.x; foo's 1.2.0 is the newest 1.x.
    assert.deepEqual(outdated(result), ["package.json foo 1.1.0 → 1.2.0"]);
    assert.deepEqual(
      result.exempted.map(({ name, allow }) => `${name} ${String(allow)}`),
      ["@scope/bar minor", "foo minor"],
    );
  });

  it("fails on an invalid latest-or-bust.json", async () => {
    npmProject({});
    const base = repo.commit();
    repo.write({ "latest-or-bust.json": { exempt: { foo: {} } } });
    await assert.rejects(run(base), /exempt\.foo needs a reason/);
  });

  it("applies pnpm's cooldown without pnpm-lock.yaml", async () => {
    repo.write({ ".npmrc": `registry=${registry.url}\n`, "package.json": { dependencies: {} } });
    const base = repo.commit();
    repo.write({
      "package.json": { dependencies: { foo: "1.2.0" } },
      "pnpm-workspace.yaml": "minimumReleaseAge: 1440\n",
    });
    // Not "1.2.0 → 1.3.0": 1.3.0 is younger than a day.
    assert.deepEqual(outdated(await run(base)), []);
  });

  it("checks npm workspace packages, new ones too, and nothing outside them", async () => {
    npmProject(
      { workspaces: ["packages/*"] },
      { "packages/a/package.json": { dependencies: { foo: "1.0.0" } } },
    );
    const base = repo.commit();
    npmProject(
      { workspaces: ["packages/*"] },
      {
        "packages/a/package.json": { dependencies: { foo: "1.1.0" } },
        "packages/new/package.json": { devDependencies: { "@scope/bar": "1.0.0" } },
        "test/fixture/package.json": { dependencies: { foo: "1.0.0" } },
      },
    );
    assert.deepEqual(outdated(await run(base)), [
      "packages/a/package.json foo 1.1.0 → 1.2.0",
      "packages/new/package.json @scope/bar 1.0.0 → 2.0.0",
    ]);
  });

  it("checks pnpm workspace packages, with pnpm's minimumReleaseAge", async () => {
    const workspace = "packages:\n  - 'packages/*'\n";
    pnpmProject(workspace, { "packages/a/package.json": { dependencies: { foo: "1.0.0" } } });
    const base = repo.commit();
    pnpmProject(workspace, {
      "packages/a/package.json": { dependencies: { foo: "1.1.0", baz: "workspace:*" } },
    });
    assert.deepEqual(outdated(await run(base)), ["packages/a/package.json foo 1.1.0 → 1.2.0"]);
  });

  it("checks changed pnpm catalog entries, not packages' own pins of them", async () => {
    pnpmProject("packages:\n  - web\ncatalog:\n  foo: 1.0.0\n", {
      "web/package.json": { dependencies: { foo: "1.0.0", baz: "catalog:" } },
    });
    const base = repo.commit();
    pnpmProject("packages:\n  - web\ncatalog:\n  foo: 1.1.0\n  baz: 3.0.0\n");
    const result = await run(base);
    assert.deepEqual(result.checked, new Map([["pnpm-workspace.yaml", ["baz", "foo"]]]));
    assert.deepEqual(outdated(result), ["pnpm-workspace.yaml foo 1.1.0 → 1.2.0"]);
  });

  it("checks named pnpm catalogs too", async () => {
    pnpmProject("packages: [web]\ncatalogs:\n  legacy:\n    '@scope/bar': 1.0.0\n");
    const base = repo.commit();
    pnpmProject(
      "packages: [web]\ncatalogs:\n  legacy:\n    '@scope/bar': ^1.0.0\n  next:\n    foo: 1.2.0\n",
    );
    const result = await run(base);
    assert.deepEqual(result.checked, new Map([["pnpm-workspace.yaml", ["@scope/bar", "foo"]]]));
    assert.deepEqual(outdated(result), ["pnpm-workspace.yaml @scope/bar ^1.0.0 → ^2.0.0"]);
  });

  it("judges each catalog's entry by its own spec", async () => {
    pnpmProject("catalog:\n  foo: 1.0.0\ncatalogs:\n  legacy:\n    foo: ^1.0.0\n");
    const base = repo.commit();
    // legacy holds foo back, untouched; next's foo is current; the default's isn't.
    pnpmProject(
      "catalog:\n  foo: 1.1.0\ncatalogs:\n  legacy:\n    foo: ^1.0.0\n  next:\n    foo: 1.2.0\n",
    );
    const result = await run(base);
    assert.deepEqual(result.checked, new Map([["pnpm-workspace.yaml", ["foo"]]]));
    assert.deepEqual(outdated(result), ["pnpm-workspace.yaml foo 1.1.0 → 1.2.0"]);
  });

  it("checks catalogs without a packages list or pnpm-lock.yaml, with the cooldown", async () => {
    repo.write({
      ".npmrc": `registry=${registry.url}\n`,
      "pnpm-workspace.yaml": "minimumReleaseAge: 1440\ncatalog:\n  foo: 1.0.0\n",
      "package.json": { name: "root" },
    });
    const base = repo.commit();
    repo.write({ "pnpm-workspace.yaml": "minimumReleaseAge: 1440\ncatalog:\n  foo: 1.1.0\n" });
    assert.deepEqual(outdated(await run(base)), ["pnpm-workspace.yaml foo 1.1.0 → 1.2.0"]);
  });

  it("ignores .ncurc, whatever it says", async () => {
    npmProject({ workspaces: ["packages/*"] });
    const base = repo.commit();
    const manifest = {
      workspaces: ["packages/*"],
      devDependencies: { foo: "1.0.0", "@scope/bar": "1.0.0" },
    };
    npmProject(manifest, {
      ".ncurc.json": {
        reject: ["@scope/bar"],
        upgrade: true,
        workspaces: true,
        dep: "prod",
        errorLevel: 2,
        jsonAll: true,
      },
      "packages/a/package.json": { name: "a" },
    });
    assert.deepEqual(outdated(await run(base)), [
      "package.json @scope/bar 1.0.0 → 2.0.0",
      "package.json foo 1.0.0 → 1.2.0",
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(repo.root, "package.json"), "utf8")), manifest);
  });

  it("fails when the root has no package.json or pnpm-workspace.yaml", async () => {
    repo.write({ "web/package.json": { dependencies: {} } });
    const base = repo.commit();
    repo.write({ "web/package.json": { dependencies: { foo: "1.0.0" } } });
    await assert.rejects(
      run(base),
      /no package\.json or pnpm-workspace\.yaml at the repository root/,
    );
  });

  it("fails on an unparseable manifest, naming it", async () => {
    npmProject({});
    const base = repo.commit();
    repo.write({ "package.json": "{" });
    await assert.rejects(run(base), /Can't parse .*package\.json/);
  });
});

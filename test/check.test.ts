// End to end through git and npm-check-updates, against a fake registry.

import assert from "node:assert/strict";
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

  it("skips what the root .ncurc rejects, in every package", async () => {
    npmProject({ workspaces: ["packages/*"] });
    const base = repo.commit();
    npmProject(
      { workspaces: ["packages/*"], dependencies: { foo: "1.0.0" } },
      {
        ".ncurc.json": { reject: ["foo"] },
        "packages/a/package.json": { dependencies: { foo: "1.0.0", baz: "3.0.0" } },
      },
    );
    const result = await run(base);
    assert.deepEqual(
      result.checked,
      new Map([
        ["package.json", ["foo"]],
        ["packages/a/package.json", ["baz", "foo"]],
      ]),
    );
    assert.deepEqual(result.outdated, []);
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

  it("explains that catalogs need pnpm-workspace.yaml's packages", async () => {
    pnpmProject("");
    const base = repo.commit();
    pnpmProject("catalog:\n  foo: 1.2.0\n");
    await assert.rejects(run(base), /lists no packages/);
  });

  it("fails on an unparseable manifest, naming it", async () => {
    npmProject({});
    const base = repo.commit();
    repo.write({ "package.json": "{" });
    await assert.rejects(run(base), /Can't parse .*package\.json/);
  });
});

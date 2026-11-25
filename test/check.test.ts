// End to end through git and npm-check-updates, against a fake registry.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, beforeEach, afterEach, describe, it } from "node:test";
import { check, type CheckResult } from "../src/check.ts";
import { createRepository, startRegistry, type Registry, type Repository } from "./fixtures.ts";

let registry: Registry;
let repo: Repository;
// pnpm's global config dir is XDG_CONFIG_HOME/pnpm: a throwaway one, so the
// machine's doesn't change what the tests find.
let configHome: string;
const savedConfigHome = process.env["XDG_CONFIG_HOME"];

before(async () => {
  configHome = mkdtempSync(join(tmpdir(), "latest-or-bust-config-"));
  process.env["XDG_CONFIG_HOME"] = configHome;
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
    // Its only release is younger than the cooldowns.
    fresh: [["1.0.0", 0.1]],
  });
});

after(async () => {
  await registry.close();
  rmSync(configHome, { recursive: true, force: true });
  if (savedConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = savedConfigHome;
});

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

/** A pnpm project on pnpm `version`, whose pnpm-workspace.yaml is `workspace`. */
function pnpmOn(version: string, workspace: string, dependencies: object): void {
  repo.write({
    ".npmrc": `registry=${registry.url}\n`,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": workspace,
    "package.json": { packageManager: `pnpm@${version}`, dependencies },
  });
}

/** What a pnpm project on pnpm `version` flags when it adds foo 1.2.0; its newest, 1.3.0, is younger than a day. */
async function addFoo(version: string, workspace = ""): Promise<string[]> {
  pnpmOn(version, workspace, {});
  const base = repo.commit();
  pnpmOn(version, workspace, { foo: "1.2.0" });
  return outdated(await run(base));
}

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

  // The newest of foo, 1.3.0, and of fresh, 1.0.0, are in the cooldown.
  it("fails on a dependency it finds no release of, and passes the rest", async () => {
    npmProject({ dependencies: {} });
    const base = repo.commit();
    npmProject({
      dependencies: { foo: "1.2.0", "not-on-the-registry": "^1.0.0" },
      devDependencies: { fresh: "1.0.0" },
    });
    const result = await run(base);
    assert.deepEqual(result.outdated, []);
    assert.deepEqual(result.notFound, [
      { file: "package.json", name: "not-on-the-registry", spec: "^1.0.0" },
    ]);
  });

  it("fails on a dependency it finds no release of in a catalog, or on its major", async () => {
    pnpmProject("");
    const base = repo.commit();
    pnpmProject("catalogs:\n  next:\n    fresh: 1.0.0\n    missing: ^1.0.0\n", {
      "latest-or-bust.json": { exempt: { gone: { reason: "testing", allow: "minor" } } },
      "package.json": { name: "root", dependencies: { gone: "^2.0.0" } },
    });
    const result = await run(base);
    assert.deepEqual(result.notFound, [
      { file: "package.json", name: "gone", spec: "^2.0.0" },
      { file: "pnpm-workspace.yaml", catalog: "next", name: "missing", spec: "^1.0.0" },
    ]);
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
    assert.equal(result.outdated[0]?.allow, "minor");
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

  it("compares a name in more than one section in each", async () => {
    npmProject({ dependencies: { foo: "1.0.0" }, devDependencies: { foo: "1.0.0" } });
    const base = repo.commit();
    npmProject({ dependencies: { foo: "1.1.0" }, devDependencies: { foo: "1.0.0", baz: "3.0.0" } });
    const result = await run(base);
    assert.deepEqual(result.checked, new Map([["package.json", ["baz", "foo"]]]));
    assert.deepEqual(result.outdated, [
      {
        file: "package.json",
        section: "dependencies",
        name: "foo",
        spec: "1.1.0",
        latest: "1.2.0",
      },
    ]);
  });

  it("leaves alone a dependency moved to another section with the same spec", async () => {
    npmProject({ dependencies: { foo: "1.0.0", baz: "3.0.0" } });
    const base = repo.commit();
    npmProject({ dependencies: { baz: "3.0.0" }, devDependencies: { foo: "1.0.0" } });
    const result = await run(base);
    assert.equal(result.checked.size, 0);
    assert.deepEqual(result.outdated, []);
  });

  it("checks a name added to a second section, by the spec there", async () => {
    npmProject({ dependencies: { foo: "1.2.0" } });
    const base = repo.commit();
    npmProject({ dependencies: { foo: "1.2.0" }, optionalDependencies: { foo: "1.0.0" } });
    assert.deepEqual(
      (await run(base)).outdated.map(
        ({ section, spec, latest }) => `${String(section)} ${spec} → ${latest}`,
      ),
      ["optionalDependencies 1.0.0 → 1.2.0"],
    );
  });

  describe("pnpm's default minimumReleaseAge", () => {
    it("applies on pnpm 11 and later when nothing sets one", async () => {
      assert.deepEqual(await addFoo("11.0.0"), []);
      assert.deepEqual(await addFoo("12.21.0+sha512.abc"), []);
    });

    // The fake pnpm is a shell script.
    const skip = process.platform === "win32";
    it("takes pnpm's version from pnpm --version without packageManager", { skip }, async () => {
      const bin = mkdtempSync(join(tmpdir(), "latest-or-bust-bin-"));
      const path = process.env["PATH"];
      process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
      try {
        for (const [version, flagged] of [
          ["11.0.0", []],
          ["10.5.0", ["package.json foo 1.2.0 → 1.3.0"]],
        ] as const) {
          writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
          repo.write({
            ".npmrc": `registry=${registry.url}\n`,
            "pnpm-workspace.yaml": "",
            "package.json": {},
          });
          const base = repo.commit();
          repo.write({ "package.json": { dependencies: { foo: "1.2.0" } } });
          assert.deepEqual(outdated(await run(base)), flagged, `pnpm ${version}`);
        }
      } finally {
        if (path === undefined) delete process.env["PATH"];
        else process.env["PATH"] = path;
        rmSync(bin, { recursive: true, force: true });
      }
    });

    it("doesn't apply before pnpm 11", async () => {
      assert.deepEqual(await addFoo("10.28.0"), ["package.json foo 1.2.0 → 1.3.0"]);
    });

    it("gives way to one pnpm-workspace.yaml sets", async () => {
      const flagged = ["package.json foo 1.2.0 → 1.3.0"];
      assert.deepEqual(await addFoo("11.0.0", "minimumReleaseAge: 0\n"), flagged);
      assert.deepEqual(await addFoo("11.0.0", "minimum-release-age: 60\n"), flagged);
    });

    it("takes PNPM_CONFIG_MINIMUM_RELEASE_AGE over the default and the global config", async () => {
      const global = join(configHome, "pnpm", "config.yaml");
      mkdirSync(join(configHome, "pnpm"), { recursive: true });
      writeFileSync(global, "minimumReleaseAge: 1440\n");
      process.env["PNPM_CONFIG_MINIMUM_RELEASE_AGE"] = "0";
      try {
        assert.deepEqual(await addFoo("11.0.0"), ["package.json foo 1.2.0 → 1.3.0"]);
      } finally {
        delete process.env["PNPM_CONFIG_MINIMUM_RELEASE_AGE"];
        rmSync(join(configHome, "pnpm"), { recursive: true, force: true });
      }
    });

    it("leaves out what minimumReleaseAgeExclude names", async () => {
      assert.deepEqual(await addFoo("11.0.0", "minimumReleaseAgeExclude:\n  - foo\n"), [
        "package.json foo 1.2.0 → 1.3.0",
      ]);
    });

    it("gives way to one pnpm's global config sets, and leaves that file alone", async () => {
      const global = join(configHome, "pnpm", "config.yaml");
      mkdirSync(join(configHome, "pnpm"), { recursive: true });
      writeFileSync(global, "minimumReleaseAge: 0\n");
      try {
        assert.deepEqual(await addFoo("11.0.0"), ["package.json foo 1.2.0 → 1.3.0"]);
        assert.equal(readFileSync(global, "utf8"), "minimumReleaseAge: 0\n");
      } finally {
        rmSync(join(configHome, "pnpm"), { recursive: true, force: true });
      }
    });

    it("keeps the global config's other settings, such as the registry", async () => {
      mkdirSync(join(configHome, "pnpm"), { recursive: true });
      writeFileSync(join(configHome, "pnpm", "config.yaml"), `registry: ${registry.url}\n`);
      try {
        repo.write({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "package.json": {} });
        const base = repo.commit();
        // No .npmrc: the registry comes from the global config. Only the fake
        // registry has a foo 1.2.0, and the cooldown keeps 1.3.0 out.
        repo.write({
          "package.json": { packageManager: "pnpm@11.0.0", dependencies: { foo: "1.1.0" } },
        });
        const result = await run(base);
        assert.deepEqual(result.notFound, []);
        assert.deepEqual(outdated(result), ["package.json foo 1.1.0 → 1.2.0"]);
      } finally {
        rmSync(join(configHome, "pnpm"), { recursive: true, force: true });
      }
    });
  });

  it("checks npm workspace packages, new ones too, and nothing outside them", async () => {
    npmProject(
      { workspaces: ["packages/**"] },
      { "packages/a/package.json": { dependencies: { foo: "1.0.0" } } },
    );
    const base = repo.commit();
    npmProject(
      { workspaces: ["packages/**"] },
      {
        "packages/a/package.json": { dependencies: { foo: "1.1.0" } },
        "packages/new/package.json": { devDependencies: { "@scope/bar": "1.0.0" } },
        // Matches the pattern and isn't ignored, but is never a workspace package.
        "packages/a/node_modules/x/package.json": { dependencies: { foo: "1.0.0" } },
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
    assert.equal(result.outdated[0]?.catalog, "legacy");
  });

  it("checks a named catalog with a colon in its name", async () => {
    pnpmProject("catalogs:\n  'react:17':\n    foo: 1.0.0\n");
    const base = repo.commit();
    pnpmProject("catalogs:\n  'react:17':\n    foo: 1.1.0\n");
    const result = await run(base);
    assert.deepEqual(result.checked, new Map([["pnpm-workspace.yaml", ["foo"]]]));
    assert.deepEqual(outdated(result), ["pnpm-workspace.yaml foo 1.1.0 → 1.2.0"]);
    assert.equal(result.outdated[0]?.catalog, "react:17");
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

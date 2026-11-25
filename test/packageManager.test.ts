import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bunCooldown,
  configuresInstall,
  detectPackageManager,
  MARKER_FILES,
  yarnCooldown,
} from "../src/packageManager.ts";

const detect = (manifest: object | undefined, ...files: string[]) =>
  detectPackageManager(
    manifest === undefined ? undefined : JSON.stringify(manifest),
    new Set(files),
  );

describe("detectPackageManager", () => {
  it("takes the one package.json's packageManager names", () => {
    assert.equal(detect({ packageManager: "yarn@4.12.0" }, "pnpm-lock.yaml"), "yarn");
    assert.equal(detect({ packageManager: "bun@1.3.0+sha512.abc" }), "bun");
    assert.equal(detect({ packageManager: "pnpm" }, "yarn.lock"), "pnpm");
  });

  it("goes by the files when packageManager names none it knows", () => {
    assert.equal(detect({ packageManager: "deno@2.0.0" }, "yarn.lock"), "yarn");
    assert.equal(detect({ packageManager: 12 }, "bun.lock"), "bun");
  });

  it("goes by the lockfile, then the config files", () => {
    assert.equal(detect({}, "pnpm-lock.yaml"), "pnpm");
    assert.equal(detect({}, "yarn.lock"), "yarn");
    assert.equal(detect({}, "bun.lock"), "bun");
    assert.equal(detect({}, "bun.lockb"), "bun");
    assert.equal(detect({}, "package-lock.json"), "npm");
    assert.equal(detect({}, "pnpm-workspace.yaml"), "pnpm");
    assert.equal(detect({}, ".yarnrc.yml"), "yarn");
    assert.equal(detect({}, "bunfig.toml"), "bun");
    // A lockfile says more than another's config file.
    assert.equal(detect({}, "bunfig.toml", "yarn.lock"), "yarn");
  });

  it("is npm without any of them, or a package.json", () => {
    assert.equal(detect({}), "npm");
    assert.equal(detect(undefined), "npm");
  });

  it("looks for every file it knows", () => {
    for (const file of ["pnpm-lock.yaml", "yarn.lock", "bun.lock", ".yarnrc.yml", "bunfig.toml"]) {
      assert.ok(MARKER_FILES.includes(file), file);
    }
  });
});

describe("bunCooldown", () => {
  it("reads minimumReleaseAge, in seconds, and its exclusions", () => {
    assert.deepEqual(
      bunCooldown(
        '[install]\nminimumReleaseAge = 259200\nminimumReleaseAgeExcludes = ["@types/node"]\n',
      ),
      { minutes: 4320, exclude: ["@types/node"] },
    );
    assert.deepEqual(bunCooldown("install.minimumReleaseAge = 90\n"), {
      minutes: 1.5,
      exclude: [],
    });
    assert.deepEqual(bunCooldown("[install]\nminimumReleaseAge = 0\n"), {
      minutes: 0,
      exclude: [],
    });
  });

  it("takes each setting from the project's bunfig.toml, else the global one", () => {
    const global = '[install]\nminimumReleaseAge = 86400\nminimumReleaseAgeExcludes = ["foo"]\n';
    assert.deepEqual(bunCooldown("[install]\nexact = true\n", global), {
      minutes: 1440,
      exclude: ["foo"],
    });
    assert.deepEqual(bunCooldown("[install]\nminimumReleaseAge = 0\n", global), {
      minutes: 0,
      exclude: ["foo"],
    });
    assert.deepEqual(bunCooldown(undefined, global), { minutes: 1440, exclude: ["foo"] });
  });

  it("is undefined without a file or setting", () => {
    assert.equal(bunCooldown(undefined), undefined);
    assert.equal(bunCooldown(undefined, undefined), undefined);
    assert.equal(bunCooldown(""), undefined);
    assert.equal(bunCooldown('[install]\nregistry = "https://example.invalid/"\n'), undefined);
  });

  it("fails on a setting Bun wouldn't take", () => {
    assert.throws(() => bunCooldown('[install]\nminimumReleaseAge = "3d"\n'), /number of seconds/);
    assert.throws(() => bunCooldown("[install]\nminimumReleaseAge = -1\n"), /number of seconds/);
    assert.throws(
      () => bunCooldown("[install]\nminimumReleaseAge = 1\nminimumReleaseAgeExcludes = [1]\n"),
      /list of package names/,
    );
    assert.throws(() => bunCooldown("[install\n"));
  });
});

describe("configuresInstall", () => {
  it("is whether bunfig.toml has an [install] table, or isn't TOML", () => {
    assert.equal(configuresInstall("[install]\n"), true);
    assert.equal(configuresInstall("install.exact = true\n"), true);
    assert.equal(configuresInstall("[test]\npreload = ['./setup.ts']\n"), false);
    assert.equal(configuresInstall(""), false);
    assert.equal(configuresInstall(undefined), false);
    // Whether it does can't be told, so it may.
    assert.equal(configuresInstall("[install\n"), true);
  });
});

describe("yarnCooldown", () => {
  it("reads npmMinimalAgeGate, in minutes or as a duration, and npmPreapprovedPackages", () => {
    assert.deepEqual(
      yarnCooldown('npmMinimalAgeGate: 1440\nnpmPreapprovedPackages: ["@types/*", 1]\n'),
      { minutes: 1440, exclude: ["@types/*"], globs: true },
    );
    assert.deepEqual(yarnCooldown("npmMinimalAgeGate: 3d\n"), {
      minutes: 4320,
      exclude: [],
      globs: true,
    });
    assert.deepEqual(yarnCooldown("npmMinimalAgeGate: 12h\n")?.minutes, 720);
  });

  it("takes both from the first file with a positive gate, as npm-check-updates does", () => {
    const home = "npmMinimalAgeGate: 60\nnpmPreapprovedPackages: [foo]\n";
    assert.deepEqual(yarnCooldown("npmPreapprovedPackages: [bar]\n", home), {
      minutes: 60,
      exclude: ["foo"],
      globs: true,
    });
    assert.deepEqual(yarnCooldown("npmMinimalAgeGate: 0\n", home)?.minutes, 60);
    assert.deepEqual(yarnCooldown("{", home)?.minutes, 60);
    assert.deepEqual(yarnCooldown(undefined, home)?.minutes, 60);
  });

  it("is undefined without a file or a positive gate", () => {
    assert.equal(yarnCooldown(undefined, undefined), undefined);
    assert.equal(yarnCooldown(""), undefined);
    assert.equal(yarnCooldown("npmMinimalAgeGate: 0\n"), undefined);
    assert.equal(yarnCooldown("npmMinimalAgeGate: 1w\n"), undefined);
    assert.equal(yarnCooldown("npmMinimalAgeGate: .inf\n"), undefined);
  });
});

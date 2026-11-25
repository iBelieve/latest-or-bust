import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogSpecs,
  changedEntries,
  changedNames,
  manifestSpecs,
  matchWorkspaces,
  workspacePatterns,
} from "../src/manifests.ts";

const manifest = (sections: Record<string, Record<string, string>>): string =>
  JSON.stringify(sections);

const specMap = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("manifestSpecs", () => {
  it("reads installed sections and skips peerDependencies", () => {
    const specs = manifestSpecs(
      manifest({
        dependencies: { hono: "^4.13.19" },
        devDependencies: { typescript: "catalog:" },
        optionalDependencies: { fsevents: "2.3.3" },
        peerDependencies: { react: ">=18" },
      }),
    );
    assert.deepEqual(
      specs,
      new Map([
        ["hono", "^4.13.19"],
        ["typescript", "catalog:"],
        ["fsevents", "2.3.3"],
      ]),
    );
  });

  it("is empty for a missing file or one without dependencies", () => {
    assert.equal(manifestSpecs(undefined).size, 0);
    assert.equal(manifestSpecs('{"name": "x"}').size, 0);
    assert.equal(manifestSpecs("[]").size, 0);
  });

  it("ignores non-string specs", () => {
    assert.equal(manifestSpecs('{"dependencies": {"x": 1}}').size, 0);
  });
});

describe("catalogSpecs", () => {
  it("reads the default catalog and keys named catalogs by name", () => {
    const specs = catalogSpecs(
      [
        "catalog:",
        "  typescript: 7.0.2",
        "catalogs:",
        "  legacy:",
        '    "@types/node": ^22.0.0',
      ].join("\n"),
    );
    assert.deepEqual(
      specs,
      new Map([
        ["typescript", "7.0.2"],
        ["legacy:@types/node", "^22.0.0"],
      ]),
    );
  });

  it("is empty without a file or catalog", () => {
    assert.equal(catalogSpecs(undefined).size, 0);
    assert.equal(catalogSpecs("packages:\n  - web\n").size, 0);
    assert.equal(catalogSpecs("just a string").size, 0);
  });
});

describe("workspacePatterns", () => {
  it("reads pnpm-workspace.yaml's packages", () => {
    assert.deepEqual(workspacePatterns(undefined, "packages:\n  - web\n  - 'packages/*'\n"), [
      "web",
      "packages/*",
    ]);
  });

  it("reads package.json's workspaces, as a list or an object", () => {
    assert.deepEqual(workspacePatterns('{"workspaces": ["packages/*"]}', undefined), [
      "packages/*",
    ]);
    assert.deepEqual(workspacePatterns('{"workspaces": {"packages": ["apps/*"]}}', undefined), [
      "apps/*",
    ]);
  });

  it("is empty without either", () => {
    assert.deepEqual(workspacePatterns(undefined, undefined), []);
    assert.deepEqual(workspacePatterns('{"name": "x"}', "catalog: {}\n"), []);
    assert.deepEqual(workspacePatterns('{"workspaces": {}}', undefined), []);
  });

  it("rejects a list of something other than strings", () => {
    assert.throws(() => workspacePatterns('{"workspaces": "packages/*"}', undefined), /workspaces/);
    assert.throws(() => workspacePatterns(undefined, "packages:\n  - 1\n"), /packages/);
  });
});

describe("matchWorkspaces", () => {
  const dirs = ["web", "packages/a", "packages/b", "packages/a/test/fixture", "docs/example"];

  it("matches plain paths and globs, sorted", () => {
    assert.deepEqual(matchWorkspaces(["web", "packages/*"], dirs), [
      "packages/a",
      "packages/b",
      "web",
    ]);
    assert.deepEqual(matchWorkspaces(["packages/**"], dirs), [
      "packages/a",
      "packages/a/test/fixture",
      "packages/b",
    ]);
  });

  it("leaves out what a ! pattern excludes", () => {
    assert.deepEqual(matchWorkspaces(["packages/**", "!**/test/**"], dirs), [
      "packages/a",
      "packages/b",
    ]);
  });

  it("takes in a ** pattern's own directory, as npm and pnpm do", () => {
    assert.deepEqual(matchWorkspaces(["web/**"], ["web", "web/x", "website"]), ["web", "web/x"]);
  });

  it("ignores ./ and trailing slashes", () => {
    assert.deepEqual(matchWorkspaces(["./web/", "./packages/b"], dirs), ["packages/b", "web"]);
  });

  it("is empty without patterns", () => {
    assert.deepEqual(matchWorkspaces([], dirs), []);
  });
});

describe("changedNames", () => {
  it("finds added and changed dependencies, sorted", () => {
    const base = specMap({ hono: "^4.13.19", react: "^19.3.1", gone: "1.0.0" });
    const head = specMap({ react: "^19.3.2", hono: "^4.13.19", added: "^1.0.0" });
    assert.deepEqual(changedNames(base, head), ["added", "react"]);
  });

  it("counts any change to a spec, including a range's floor or a downgrade", () => {
    const base = specMap({ a: "1.0.0", b: "^1.0.0", c: "2.0.0" });
    const head = specMap({ a: "~1.0.0", b: "^1.1.0", c: "1.0.0" });
    assert.deepEqual(changedNames(base, head), ["a", "b", "c"]);
  });

  it("skips specs that aren't registry versions", () => {
    const head = specMap({
      a: "catalog:",
      b: "workspace:*",
      c: "link:../c",
      d: "file:d.tgz",
      e: "npm:other@1",
      f: "git+https://example.com/f.git",
      g: "github:owner/g",
    });
    assert.deepEqual(changedNames(new Map(), head), []);
  });

  it("reports a named catalog's entry by its package name, once", () => {
    const head = specMap({ "@types/node": "^26.6.6", "legacy:@types/node": "^22.0.0" });
    assert.deepEqual(changedNames(new Map(), head), ["@types/node"]);
  });
});

describe("changedEntries", () => {
  it("groups changed entries by catalog, keyed by package name", () => {
    const base = specMap({ "@types/node": "^26.6.6", "legacy:react": "^18.3.1" });
    const head = specMap({
      "@types/node": "^26.6.6",
      "legacy:@types/node": "^22.0.0",
      "legacy:react": "^18.3.1",
      "next:react": "^19.3.2",
      "next:x": "workspace:*",
    });
    assert.deepEqual(
      changedEntries(base, head),
      new Map([
        ["legacy", specMap({ "@types/node": "^22.0.0" })],
        ["next", specMap({ react: "^19.3.2" })],
      ]),
    );
  });
});

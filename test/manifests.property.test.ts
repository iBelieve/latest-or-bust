// Property tests for the pure functions in manifests.ts: what a change adds
// or changes must be exactly the entries whose spec differs, however the
// manifests and catalogs are made up. 200 cases each; FC_RUNS=10000 pnpm test
// searches harder. A failure prints a shrunk counterexample and a seed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { stringify } from "yaml";
import {
  catalogSpecs,
  changedEntries,
  changedNames,
  isRecord,
  manifestSpecs,
  matchWorkspaces,
  workspacePatterns,
  type Specs,
} from "../src/manifests.ts";

/** Orders map entries by key. */
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : 1);

fc.configureGlobal({ numRuns: Number(process.env["FC_RUNS"]) || 200 });

// A package name as npm allows it: lowercase, maybe scoped. Never a ":".
const word = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,8}$/);
const packageName = fc.oneof(
  word,
  fc.tuple(word, word).map(([scope, name]) => `@${scope}/${name}`),
);

// A prerelease identifier can look like a tarball's extension
// ("1.0.0-tar.1", "2.0.0-tgz.beta"), and is still a version. Not at the end,
// though: npm reads any spec ending in .tgz, .tar or .tar.gz as a tarball.
const identifier = fc.oneof(
  fc.stringMatching(/^[a-z0-9-]{1,6}$/),
  fc.constantFrom("tar", "tgz", "gz"),
);
const prerelease = fc.oneof(
  fc.constant(""),
  fc
    .array(identifier, { minLength: 1, maxLength: 3 })
    .map((identifiers) => `-${identifiers.join(".")}`)
    .filter((pre) => !/\.(tgz|tar|tar\.gz)$/.test(pre)),
);

const version = fc
  .tuple(fc.nat(30), fc.nat(30), fc.nat(30), prerelease)
  .map(([major, minor, patch, pre]) => `${major}.${minor}.${patch}${pre}`);

// A spec naming a registry version: exact, a range, or a dist-tag.
const registrySpec = fc.oneof(
  version,
  version.map((v) => `^${v}`),
  version.map((v) => `~${v}`),
  version.map((v) => `>=${v}`),
  fc.tuple(version, version).map(([a, b]) => `${a} - ${b}`),
  fc.constantFrom("*", "latest", "next", "1.x", "^2"),
);

// Every spec otherSpec makes, so a test knows which ones aren't looked up
// without repeating how manifests.ts tells them apart. No registry spec has a
// ":" or "/" or ends in .tgz, so the two kinds never overlap.
const generatedOther = new Set<string>();

// One that doesn't name a registry version, so it's never looked up.
const otherSpec = fc
  .oneof(
    fc.constantFrom("catalog:", "workspace:*", "workspace:^", "link:../x", "file:./vendor/x.tgz"),
    fc.tuple(word, registrySpec).map(([name, spec]) => `npm:${name}@${spec}`),
    fc.tuple(word, word).map(([catalog, name]) => `catalog:${catalog}-${name}`),
    fc.tuple(word, word).map(([owner, repo]) => `${owner}/${repo}`),
    fc.tuple(word, word).map(([host, repo]) => `git@${host}:${repo}.git`),
    fc.tuple(word, word).map(([owner, repo]) => `https://example.com/${owner}/${repo}.tgz`),
    word.map((name) => `${name}.tgz`),
  )
  .map((value) => {
    generatedOther.add(value);
    return value;
  });

const spec = fc.oneof({ arbitrary: registrySpec, weight: 3 }, { arbitrary: otherSpec, weight: 1 });

const specs = (value: fc.Arbitrary<string> = spec) =>
  fc
    .dictionary(packageName, value, { maxKeys: 8 })
    .map((entries) => new Map(Object.entries(entries)));

// A named catalog's name: anything but empty, colons included ("react:17").
const catalogName = fc.oneof(
  word,
  fc.tuple(word, word).map(([a, b]) => `${a}:${b}`),
);

// pnpm-workspace.yaml's catalogs: the default one, and named ones.
const catalogs = fc.record({
  catalog: specs(),
  catalogs: fc
    .dictionary(catalogName, specs(), { maxKeys: 3 })
    .map((named) => new Map(Object.entries(named))),
});

type Catalogs = { catalog: Specs; catalogs: Map<string, Specs> };

const workspaceYaml = (workspace: Catalogs): string =>
  stringify({
    catalog: Object.fromEntries(workspace.catalog),
    catalogs: Object.fromEntries(
      [...workspace.catalogs].map(([name, entries]) => [name, Object.fromEntries(entries)]),
    ),
  });

const isRegistry = (value: string): boolean => !generatedOther.has(value);

const registryOnly = (entries: Specs): Specs =>
  new Map([...entries].filter(([, value]) => isRegistry(value)));

/** `head` changed against `base`: same keys, some specs changed, some keys added and removed. */
const change = specs().chain((base) =>
  fc
    .record({
      changed: fc.subarray([...base.keys()]),
      removed: fc.subarray([...base.keys()]),
      added: specs(),
      newSpecs: fc.array(spec, { minLength: base.size, maxLength: base.size }),
    })
    .map(({ changed, removed, added, newSpecs }) => {
      const head = new Map(base);
      changed.forEach((name, index) => head.set(name, newSpecs[index] ?? ""));
      for (const name of removed) head.delete(name);
      for (const [name, value] of added) head.set(name, value);
      return { base, head };
    }),
);

describe("changedEntries", () => {
  it("finds nothing when nothing changed", () => {
    fc.assert(
      fc.property(specs(), (same) => {
        assert.equal(changedEntries(same, new Map(same)).size, 0);
      }),
    );
  });

  it("finds exactly the registry specs that were added or changed", () => {
    fc.assert(
      fc.property(change, ({ base, head }) => {
        const expected = [...head]
          .filter(([name, value]) => base.get(name) !== value && isRegistry(value))
          .toSorted(byKey);
        const found = changedEntries(base, head);
        assert.deepEqual([...found.keys()], expected.length === 0 ? [] : [""]);
        const entries = [...(found.get("") ?? [])].toSorted(byKey);
        assert.deepEqual(entries, expected);
      }),
    );
  });

  it("never reports a removed dependency", () => {
    fc.assert(
      fc.property(specs(), specs(), (base, head) => {
        for (const entries of changedEntries(base, head).values()) {
          for (const name of entries.keys()) assert.ok(head.has(name));
        }
      }),
    );
  });

  it("splits catalog entries back into the catalogs they came from", () => {
    fc.assert(
      fc.property(catalogs, (workspace) => {
        const found = changedEntries(new Map(), catalogSpecs(workspaceYaml(workspace)));
        const expected = new Map<string, Specs>();
        for (const [name, entries] of [["", workspace.catalog] as const, ...workspace.catalogs]) {
          const kept = registryOnly(entries);
          if (kept.size > 0) expected.set(name, kept);
        }
        assert.deepEqual(
          new Map([...found].toSorted(byKey)),
          new Map([...expected].toSorted(byKey)),
        );
      }),
    );
  });
});

describe("changedNames", () => {
  it("is the sorted, distinct names changedEntries finds in every catalog", () => {
    fc.assert(
      fc.property(catalogs, catalogs, (before, after) => {
        const [base, head] = [before, after].map((workspace) =>
          catalogSpecs(workspaceYaml(workspace)),
        );
        assert.ok(base !== undefined && head !== undefined);
        const names = changedNames(base, head);
        assert.deepEqual(names, [...new Set(names)].toSorted());
        const expected = new Set<string>();
        for (const entries of changedEntries(base, head).values()) {
          for (const name of entries.keys()) expected.add(name);
        }
        assert.deepEqual(new Set(names), expected);
      }),
    );
  });
});

/** A section's string entries. */
const strings = (entries: Record<string, unknown> | undefined): Specs =>
  new Map(
    Object.entries(entries ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

describe("manifestSpecs", () => {
  it("reads back each installed section's string specs, and nothing else", () => {
    // A section's entry is a spec, or anything else JSON allows, which isn't one.
    const section = fc.dictionary(packageName, fc.oneof(spec, fc.jsonValue()), { maxKeys: 6 });
    fc.assert(
      fc.property(
        fc.record(
          {
            dependencies: section,
            devDependencies: section,
            optionalDependencies: section,
            peerDependencies: section,
          },
          { requiredKeys: [] },
        ),
        fc.dictionary(word, fc.jsonValue(), { maxKeys: 3 }),
        (sections, other) => {
          assert.deepEqual(manifestSpecs(JSON.stringify({ ...other, ...sections })), {
            dependencies: strings(sections.dependencies),
            devDependencies: strings(sections.devDependencies),
            optionalDependencies: strings(sections.optionalDependencies),
          });
        },
      ),
    );
  });

  it("reads any JSON without throwing", () => {
    fc.assert(
      fc.property(fc.json(), (text) => {
        for (const section of Object.values(manifestSpecs(text))) {
          for (const value of section.values()) assert.equal(typeof value, "string");
        }
      }),
    );
  });
});

describe("catalogSpecs", () => {
  it("finds no catalogs in a pnpm-workspace.yaml that isn't a mapping", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom("", "# just a comment\n", "~\n"),
          fc
            .jsonValue()
            .filter((value) => !isRecord(value))
            .map((value) => stringify(value)),
        ),
        (text) => {
          assert.equal(catalogSpecs(text).size, 0);
          assert.deepEqual(workspacePatterns(undefined, text), []);
        },
      ),
    );
  });
});

describe("workspacePatterns", () => {
  const patterns = fc.array(
    fc.oneof(
      word,
      word.map((dir) => `${dir}/*`),
      word.map((dir) => `!${dir}`),
    ),
    {
      maxLength: 4,
    },
  );

  it("reads pnpm-workspace.yaml's packages, then package.json's workspaces, in either form", () => {
    fc.assert(
      fc.property(patterns, patterns, fc.boolean(), (pnpm, npm, wrapped) => {
        const manifest = JSON.stringify({ workspaces: wrapped ? { packages: npm } : npm });
        assert.deepEqual(workspacePatterns(manifest, stringify({ packages: pnpm })), [
          ...pnpm,
          ...npm,
        ]);
      }),
    );
  });

  it("refuses anything but a list of strings", () => {
    fc.assert(
      fc.property(
        // Not a list of strings, nor an object (package.json's { packages }).
        fc
          .jsonValue()
          .filter(
            (value) =>
              !isRecord(value) &&
              !(Array.isArray(value) && value.every((entry) => typeof entry === "string")),
          ),
        (value) => {
          assert.throws(
            () => workspacePatterns(undefined, stringify({ packages: value })),
            /must be a list/,
          );
          assert.throws(
            () => workspacePatterns(JSON.stringify({ workspaces: value }), undefined),
            /must be a list/,
          );
        },
      ),
    );
  });
});

describe("matchWorkspaces", () => {
  const dir = fc.array(word, { minLength: 1, maxLength: 3 }).map((parts) => parts.join("/"));
  const dirs = fc.uniqueArray(dir, { maxLength: 8 });
  const someDirs = fc.uniqueArray(dir, { minLength: 1, maxLength: 8 });

  it("takes in a directory named outright, however it's written", () => {
    fc.assert(
      fc.property(
        someDirs,
        fc.nat(),
        fc.constantFrom("", "./"),
        fc.constantFrom("", "/"),
        (candidates, index, prefix, suffix) => {
          const named = candidates[index % candidates.length] ?? "";
          assert.ok(matchWorkspaces([`${prefix}${named}${suffix}`], candidates).includes(named));
        },
      ),
    );
  });

  it("is a sorted subset of the candidates, without the excluded ones", () => {
    fc.assert(
      fc.property(
        dirs,
        fc.array(
          fc.oneof(
            dir,
            dir.map((d) => `${d}/*`),
            fc.constant("**"),
          ),
          { maxLength: 3 },
        ),
        dirs,
        (candidates, include, exclude) => {
          const matched = matchWorkspaces([...include, ...exclude.map((d) => `!${d}`)], candidates);
          assert.deepEqual(matched, matched.toSorted());
          for (const found of matched) {
            assert.ok(candidates.includes(found));
            assert.ok(!exclude.includes(found));
          }
          // An exclusion only ever takes directories out.
          const without = new Set(matchWorkspaces(include, candidates));
          for (const found of matched) assert.ok(without.has(found));
        },
      ),
    );
  });

  it("takes in every candidate for **, and none without a pattern", () => {
    fc.assert(
      fc.property(dirs, (candidates) => {
        assert.deepEqual(matchWorkspaces(["**"], candidates), candidates.toSorted());
        assert.deepEqual(matchWorkspaces([], candidates), []);
      }),
    );
  });
});

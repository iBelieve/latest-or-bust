// Property tests for latest-or-bust.json: a valid config reads back as
// written, and anything else fails with an error that names the file. 200
// cases each; FC_RUNS=10000 pnpm test searches harder.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { CONFIG_FILE, parseConfig, type Exemption } from "../src/config.ts";

fc.configureGlobal({ numRuns: Number(process.env["FC_RUNS"]) || 200 });

// Any name: the config doesn't check that it's a valid package name.
const name = fc.string({ minLength: 1, maxLength: 12 });

const reason = fc.string({ minLength: 1 }).filter((text) => text.trim() !== "");

const exemption: fc.Arbitrary<Exemption> = fc.oneof(
  reason.map((text) => ({ reason: text })),
  reason.map((text) => ({ reason: text, allow: "minor" as const })),
);

const exemptions = fc.dictionary(name, exemption, { maxKeys: 6 });

const unknownKey = (known: string[]) => fc.string().filter((key) => !known.includes(key));

describe("parseConfig", () => {
  it("reads back the exemptions it's given", () => {
    fc.assert(
      fc.property(exemptions, fc.boolean(), (exempt, schema) => {
        const text = JSON.stringify({ ...(schema ? { $schema: "./schema.json" } : {}), exempt });
        assert.deepEqual(parseConfig(text).exempt, new Map(Object.entries(exempt)));
      }),
    );
  });

  it("refuses an exemption without a real reason", () => {
    fc.assert(
      fc.property(
        exemptions,
        name,
        fc.oneof(
          fc.constant(undefined),
          fc.stringMatching(/^\s*$/),
          fc.jsonValue().filter((value) => typeof value !== "string"),
        ),
        (exempt, held, missing) => {
          const text = JSON.stringify({ exempt: { ...exempt, [held]: { reason: missing } } });
          assert.throws(() => parseConfig(text), /needs a reason/);
        },
      ),
    );
  });

  it("refuses keys it doesn't know, at either level", () => {
    fc.assert(
      fc.property(
        exemptions,
        unknownKey(["$schema", "exempt"]),
        fc.jsonValue(),
        (exempt, key, value) => {
          assert.throws(() => parseConfig(JSON.stringify({ exempt, [key]: value })), /unknown key/);
        },
      ),
    );
    fc.assert(
      fc.property(
        name,
        exemption,
        unknownKey(["reason", "allow"]),
        fc.jsonValue(),
        (held, entry, key, value) => {
          const text = JSON.stringify({ exempt: { [held]: { ...entry, [key]: value } } });
          assert.throws(() => parseConfig(text), /unknown key/);
        },
      ),
    );
  });

  it("names every unknown key", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.stringMatching(/^[a-z]{1,8}$/).filter((key) => key !== "exempt"),
          { minLength: 1, maxLength: 4 },
        ),
        (keys) => {
          const text = JSON.stringify(Object.fromEntries(keys.map((key) => [key, true])));
          assert.throws(() => parseConfig(text), {
            message: `${CONFIG_FILE}: unknown key: ${keys.join(", ")}`,
          });
        },
      ),
    );
  });

  it("either reads any JSON or fails naming the file", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.json(),
          fc
            .record({ exempt: fc.dictionary(name, fc.jsonValue()) })
            .map((value) => JSON.stringify(value)),
          fc.string(),
        ),
        (text) => {
          try {
            for (const [, entry] of parseConfig(text).exempt) {
              assert.equal(typeof entry.reason, "string");
              assert.ok(entry.allow === undefined || entry.allow === "minor");
            }
          } catch (error) {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(CONFIG_FILE), error.message);
          }
        },
      ),
    );
  });
});

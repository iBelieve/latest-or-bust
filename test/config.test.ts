import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConfig } from "../src/config.ts";

const parse = (value: unknown) => parseConfig(JSON.stringify(value));

describe("parseConfig", () => {
  it("is empty without a file or exemptions", () => {
    assert.equal(parseConfig(undefined).exempt.size, 0);
    assert.equal(parse({}).exempt.size, 0);
    assert.equal(parse({ $schema: "x", exempt: {} }).exempt.size, 0);
  });

  it("reads exemptions, with allow when it's given", () => {
    const config = parse({
      exempt: {
        foo: { reason: "foo 2 drops Node.js 22", allow: "minor" },
        "@scope/bar": { reason: "bar 3 is broken" },
      },
    });
    assert.deepEqual(
      config.exempt,
      new Map([
        ["foo", { reason: "foo 2 drops Node.js 22", allow: "minor" }],
        ["@scope/bar", { reason: "bar 3 is broken" }],
      ]),
    );
  });

  it("needs a reason for each exemption", () => {
    assert.throws(() => parse({ exempt: { foo: {} } }), /exempt\.foo needs a reason/);
    assert.throws(() => parse({ exempt: { foo: { reason: " " } } }), /needs a reason/);
    assert.throws(() => parse({ exempt: { foo: "because" } }), /must be an object with a reason/);
  });

  it("refuses unknown keys and allow values", () => {
    assert.throws(() => parse({ reject: ["foo"] }), /unknown key: reject/);
    assert.throws(
      () => parse({ exempt: { foo: { reason: "x", comment: "y" } } }),
      /unknown key in exempt\.foo: comment/,
    );
    assert.throws(
      () => parse({ exempt: { foo: { reason: "x", allow: "major" } } }),
      /allow must be "minor"/,
    );
  });

  it("refuses what isn't an object, or isn't JSON", () => {
    assert.throws(() => parse([]), /latest-or-bust\.json: must be an object/);
    assert.throws(() => parse({ exempt: [] }), /exempt must be an object/);
    assert.throws(() => parseConfig("{"), /Can't parse latest-or-bust\.json/);
  });
});

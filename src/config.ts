// latest-or-bust.json, at the repository root: the dependencies held back on
// purpose, each with the reason why. latest-or-bust reads no other tool's
// config (not npm-check-updates' .ncurc), so what it checks doesn't depend on
// how it finds the newest release.
//
//   {
//     "exempt": {
//       "foo": { "reason": "@types/foo only covers 1.x", "allow": "minor" },
//       "bar": { "reason": "bar 3 drops Node.js 22" }
//     }
//   }
//
// "allow": "minor" lets a dependency stay on its major version, but it must
// be the newest release there. Without "allow", it isn't checked at all.
//
// "promotions" lists the pull requests that merge one long-lived branch into
// another, which aren't checked: their dependencies were checked on the way
// into the first branch. It defaults to develop into main or master; [] checks
// every pull request.
//
//   { "promotions": [{ "from": "next", "into": "main" }] }

import { isRecord } from "./manifests.ts";

export const CONFIG_FILE = "latest-or-bust.json";

export interface Exemption {
  reason: string;
  /** "minor": the newest release on its current major. Undefined: not checked. */
  allow?: "minor";
}

/** A pull request from one branch into another that isn't checked. */
export interface Promotion {
  from: string;
  into: string;
}

/** Promotions when latest-or-bust.json doesn't list any. */
export const DEFAULT_PROMOTIONS: readonly Promotion[] = [
  { from: "develop", into: "main" },
  { from: "develop", into: "master" },
];

export interface Config {
  /** Package name to its exemption. */
  exempt: Map<string, Exemption>;
  promotions: readonly Promotion[];
}

function fail(message: string): never {
  throw new Error(`${CONFIG_FILE}: ${message}`);
}

function unknownKeys(value: Record<string, unknown>, known: string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !known.includes(key));
  if (unknown.length > 0) fail(`unknown ${where}: ${unknown.join(", ")}`);
}

function exemption(name: string, value: unknown): Exemption {
  if (!isRecord(value)) fail(`exempt.${name} must be an object with a reason`);
  unknownKeys(value, ["reason", "allow"], `key in exempt.${name}`);
  const { reason, allow } = value;
  if (typeof reason !== "string" || reason.trim() === "") {
    fail(`exempt.${name} needs a reason: say why it's held back`);
  }
  if (allow === undefined) return { reason };
  if (allow !== "minor") fail(`exempt.${name}.allow must be "minor" (or left out)`);
  return { reason, allow };
}

function branch(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${where} must be a branch name`);
  return value;
}

function promotions(value: unknown): Promotion[] {
  if (!Array.isArray(value)) fail('promotions must be an array of { "from", "into" } branches');
  return value.map((entry: unknown, index) => {
    const where = `promotions[${index}]`;
    if (!isRecord(entry)) fail(`${where} must be an object with "from" and "into" branches`);
    unknownKeys(entry, ["from", "into"], `key in ${where}`);
    return {
      from: branch(entry["from"], `${where}.from`),
      into: branch(entry["into"], `${where}.into`),
    };
  });
}

/** Parses latest-or-bust.json; an empty config when there isn't one. */
export function parseConfig(text: string | undefined): Config {
  const config: Config = { exempt: new Map(), promotions: DEFAULT_PROMOTIONS };
  if (text === undefined) return config;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Can't parse ${CONFIG_FILE}`, { cause: error });
  }
  if (!isRecord(value)) fail("must be an object");
  unknownKeys(value, ["$schema", "exempt", "promotions"], "key");
  const { exempt } = value;
  if (value["promotions"] !== undefined) config.promotions = promotions(value["promotions"]);
  if (exempt === undefined) return config;
  if (!isRecord(exempt)) fail("exempt must be an object of package names");
  for (const [name, entry] of Object.entries(exempt)) {
    config.exempt.set(name, exemption(name, entry));
  }
  return config;
}

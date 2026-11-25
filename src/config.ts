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

import { isRecord } from "./manifests.ts";

export const CONFIG_FILE = "latest-or-bust.json";

export interface Exemption {
  reason: string;
  /** "minor": the newest release on its current major. Undefined: not checked. */
  allow?: "minor";
}

export interface Config {
  /** Package name to its exemption. */
  exempt: Map<string, Exemption>;
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

/** Parses latest-or-bust.json; an empty config when there isn't one. */
export function parseConfig(text: string | undefined): Config {
  const config: Config = { exempt: new Map() };
  if (text === undefined) return config;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Can't parse ${CONFIG_FILE}`, { cause: error });
  }
  if (!isRecord(value)) fail("must be an object");
  unknownKeys(value, ["$schema", "exempt"], "key");
  const { exempt } = value;
  if (exempt === undefined) return config;
  if (!isRecord(exempt)) fail("exempt must be an object of package names");
  for (const [name, entry] of Object.entries(exempt)) {
    config.exempt.set(name, exemption(name, entry));
  }
  return config;
}

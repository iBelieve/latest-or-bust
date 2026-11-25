// latest-or-bust's own config file for npm-check-updates, given explicitly so
// it doesn't look for the project's. With --jsonUpgraded, npm-check-updates
// prints only the upgrades: a package it couldn't look up (not on the
// registry, the registry unreachable, a failed login) looks just like one
// that's already the newest. filterResults is called for each package it
// found a release of, so this names them, one JSON string per line, on file
// descriptor 3, a pipe that src/ncu.ts opens. src/ncu.ts asks again, without
// the cooldown, about any it doesn't name (a package whose newer releases are
// all in the cooldown isn't named either), and those still not named, it
// couldn't look up.

import { writeSync } from "node:fs";

export default {
  /** @param {string} name */
  filterResults(name) {
    writeSync(3, `${JSON.stringify(name)}\n`);
    return true;
  },
};

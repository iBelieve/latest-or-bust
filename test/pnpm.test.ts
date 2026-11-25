import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pnpmConfigDir } from "../src/pnpm.ts";

describe("pnpmConfigDir", () => {
  const home = join("/", "home", "me");

  it("is under XDG_CONFIG_HOME when it's set, on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      assert.equal(
        pnpmConfigDir({ XDG_CONFIG_HOME: "/xdg" }, platform, home),
        join("/xdg", "pnpm"),
      );
    }
  });

  it("is the platform's config dir otherwise", () => {
    assert.equal(
      pnpmConfigDir({ XDG_CONFIG_HOME: "" }, "linux", home),
      join(home, ".config", "pnpm"),
    );
    assert.equal(pnpmConfigDir({}, "darwin", home), join(home, "Library", "Preferences", "pnpm"));
    assert.equal(
      pnpmConfigDir({ LOCALAPPDATA: "/local" }, "win32", home),
      join("/local", "pnpm", "config"),
    );
    assert.equal(
      pnpmConfigDir({}, "win32", home),
      join(home, "AppData", "Local", "pnpm", "config"),
    );
  });
});

// GitHub Actions: which base a run compares with, from its environment and
// event payload, in the shallow clone actions/checkout makes.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { detect, type Environment } from "../src/github.ts";
import { createRepository, type Repository } from "./fixtures.ts";

let upstream: Repository;
let dir: string;

beforeEach(() => {
  upstream = createRepository();
  dir = mkdtempSync(join(tmpdir(), "latest-or-bust-"));
});

afterEach(() => {
  upstream.remove();
  rmSync(dir, { recursive: true, force: true });
});

interface PullRequest {
  /** The base branch's tip when the pull request was opened. */
  baseSha: string;
  /** The base the merge was made from: the base branch's tip later on. */
  mergedInto: string;
  head: string;
  merge: string;
}

/** A pull request from a branch off main, which moves on after the branch, and GitHub's merge of it. */
function pullRequest(): PullRequest {
  upstream.write({ "a.txt": "a" });
  const baseSha = upstream.commit();
  upstream.git("checkout", "--quiet", "-b", "feature");
  upstream.write({ "b.txt": "b" });
  const head = upstream.commit();
  upstream.git("checkout", "--quiet", "main");
  upstream.write({ "c.txt": "c" });
  const mergedInto = upstream.commit();
  upstream.git("checkout", "--quiet", "--detach");
  upstream.git("merge", "--quiet", "--no-ff", "--message", "Merge", "feature");
  const merge = upstream.git("rev-parse", "HEAD");
  // Where actions/checkout fetches the merge from.
  upstream.git("update-ref", "refs/pull/1/merge", merge);
  upstream.git("checkout", "--quiet", "main");
  return { baseSha, mergedInto, head, merge };
}

/** Clones `ref` from upstream, as actions/checkout does: just that commit unless `depth` says otherwise. */
function checkout(ref: string, depth = 1): string {
  const clone = join(dir, "clone");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: clone, encoding: "utf8" });
  execFileSync("git", ["init", "--quiet", clone]);
  git("remote", "add", "origin", `file://${upstream.root}`);
  git("fetch", "--quiet", "--no-tags", ...(depth > 0 ? [`--depth=${depth}`] : []), "origin", ref);
  git("checkout", "--quiet", "--detach", "FETCH_HEAD");
  return clone;
}

function environment(event: string, body?: object, sha?: string): Environment {
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(body ?? {}));
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: event,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_SHA: sha,
  };
}

interface Branches {
  author?: string;
  head?: string;
  base?: string;
  /** The head branch's repository; the base's is acme/app. */
  fork?: string | null;
}

function payload(pr: PullRequest, branches: Branches = {}): object {
  const { author = "someone", head = "feature", base = "main", fork = "acme/app" } = branches;
  return {
    pull_request: {
      number: 1,
      user: { login: author },
      base: { ref: base, sha: pr.baseSha, repo: { full_name: "acme/app" } },
      head: { ref: head, sha: pr.head, repo: fork === null ? null : { full_name: fork } },
    },
  };
}

describe("detect", () => {
  it("leaves it to the caller outside GitHub Actions", () => {
    upstream.commit();
    assert.equal(detect(upstream.root, {}), undefined);
    assert.equal(detect(upstream.root, { GITHUB_EVENT_NAME: "pull_request" }), undefined);
  });

  it("has nothing to check on a run that isn't for a pull request", () => {
    upstream.commit();
    for (const event of ["push", "schedule", "merge_group"]) {
      const detected = detect(upstream.root, environment(event));
      assert.ok(detected !== undefined && "skip" in detected);
      assert.match(
        detected.skip,
        new RegExp(`^Not a pull request \\(this is a GitHub Actions ${event} run\\)`),
      );
    }
  });

  it("has nothing to check on a pull_request_target run, which runs on the base branch", () => {
    upstream.commit();
    const detected = detect(upstream.root, environment("pull_request_target"));
    assert.ok(detected !== undefined && "skip" in detected);
    assert.match(detected.skip, /^This is a GitHub Actions pull_request_target run, which runs on/);
  });

  it("compares a pull request's merge with the base it was made from, fetching it", () => {
    const pr = pullRequest();
    const clone = checkout("refs/pull/1/merge");
    assert.deepEqual(detect(clone, environment("pull_request", payload(pr), pr.merge)), {
      base: pr.mergedInto,
      label: "main, pull request #1's base",
    });
    // Fetched, so the files there can be read.
    execFileSync("git", ["cat-file", "-e", `${pr.mergedInto}:c.txt`], { cwd: clone });
  });

  it("compares a merge GitHub made again after the base moved with its first parent too", () => {
    const pr = pullRequest();
    // Checked out by its ref, with the history, so GITHUB_SHA (the merge when
    // the event fired) is another commit and the payload's base sha is behind.
    const clone = checkout("refs/pull/1/merge", 0);
    const earlier = "0".repeat(40);
    assert.deepEqual(detect(clone, environment("pull_request", payload(pr), earlier)), {
      base: pr.mergedInto,
      label: "main, pull request #1's base",
    });
  });

  it("compares a pull request's head with where it branched from the base", () => {
    const pr = pullRequest();
    const clone = checkout("feature", 0);
    assert.deepEqual(detect(clone, environment("pull_request", payload(pr), pr.merge)), {
      base: pr.baseSha,
      label: "where pull request #1 branched from main",
    });
  });

  it("needs the history to find where a pull request's head branched", () => {
    const pr = pullRequest();
    const clone = checkout("feature");
    assert.throws(
      () => detect(clone, environment("pull_request", payload(pr), pr.merge)),
      /Can't find where HEAD branched from main .*fetch-depth: 0/,
    );
  });

  it("fails if it can't fetch the merge's base", () => {
    const pr = pullRequest();
    const clone = checkout("refs/pull/1/merge");
    execFileSync("git", ["remote", "set-url", "origin", join(dir, "gone")], { cwd: clone });
    assert.throws(
      () => detect(clone, environment("pull_request", payload(pr), pr.merge)),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`Can't fetch ${pr.mergedInto} from origin`));
        // With git's own reason.
        assert.equal(typeof error.cause, "string");
        assert.notEqual(error.cause, "");
        return true;
      },
    );
  });

  it("doesn't check pull requests from dependency update bots", () => {
    const pr = pullRequest();
    for (const bot of ["dependabot[bot]", "renovate[bot]"]) {
      const detected = detect(
        upstream.root,
        environment("pull_request", payload(pr, { author: bot }), pr.merge),
      );
      assert.ok(detected !== undefined && "skip" in detected);
      assert.match(
        detected.skip,
        new RegExp(`^Pull request #1 is from ${bot.replace(/[[\]]/g, "\\$&")}`),
      );
    }
  });

  it("doesn't check a pull request that promotes develop into main or master", () => {
    const pr = pullRequest();
    for (const base of ["main", "master"]) {
      const env = environment("pull_request", payload(pr, { head: "develop", base }), pr.merge);
      const detected = detect(upstream.root, env);
      assert.ok(detected !== undefined && "skip" in detected);
      assert.match(
        detected.skip,
        new RegExp(
          `^Pull request #1 promotes develop into ${base}, whose dependencies were checked`,
        ),
      );
    }
  });

  it("checks other pull requests into main, and develop's into other branches", () => {
    const pr = pullRequest();
    const clone = checkout("refs/pull/1/merge");
    for (const branches of [{ head: "feature" }, { head: "develop", base: "release" }]) {
      const env = environment("pull_request", payload(pr, branches), pr.merge);
      const detected = detect(clone, env);
      assert.ok(detected !== undefined && "base" in detected, JSON.stringify(branches));
    }
  });

  it("checks a pull request from a fork's develop", () => {
    const pr = pullRequest();
    const clone = checkout("refs/pull/1/merge");
    for (const fork of ["someone/app", null]) {
      const env = environment("pull_request", payload(pr, { head: "develop", fork }), pr.merge);
      const detected = detect(clone, env);
      assert.ok(detected !== undefined && "base" in detected, String(fork));
    }
  });

  it("takes the promotions it's given instead", () => {
    const pr = pullRequest();
    const clone = checkout("refs/pull/1/merge");
    const promotions = [{ from: "next", into: "main" }];
    const skipped = detect(
      clone,
      environment("pull_request", payload(pr, { head: "next" }), pr.merge),
      promotions,
    );
    assert.ok(skipped !== undefined && "skip" in skipped);
    assert.match(skipped.skip, /promotes next into main/);
    const develop = environment("pull_request", payload(pr, { head: "develop" }), pr.merge);
    const checked = detect(clone, develop, promotions);
    assert.ok(checked !== undefined && "base" in checked);
    const none = detect(clone, develop, []);
    assert.ok(none !== undefined && "base" in none);
  });

  it("fails on an event payload without a pull request", () => {
    upstream.commit();
    assert.throws(
      () => detect(upstream.root, environment("pull_request", { action: "opened" })),
      /event\.json doesn't describe a pull request/,
    );
    assert.throws(
      () => detect(upstream.root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request" }),
      /GITHUB_EVENT_PATH isn't set/,
    );
  });

  it("names the event payload if it can't read it", () => {
    upstream.commit();
    const env = environment("pull_request");
    writeFileSync(env["GITHUB_EVENT_PATH"] ?? "", "{ not json");
    assert.throws(
      () => detect(upstream.root, env),
      /Can't read the event payload at .*event\.json/,
    );
  });
});

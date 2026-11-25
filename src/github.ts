// On GitHub Actions, the base to compare with when none is passed: a
// pull_request run compares with the pull request's base, and any other run
// has nothing to check.

import { readFileSync } from "node:fs";
import { ensureCommit, mergeBase, parents, resolveCommit } from "./git.ts";
import { isRecord } from "./manifests.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

/** What a run compares with, said the way the output names it; or why there's nothing to check. */
export type Detected = { base: string; label: string } | { skip: string };

/**
 * Dependency update bots. Their grouped minor-and-patch pull requests don't
 * move a dependency to a new major version even when one is out, so they'd
 * fail the check for doing what they're set up to do.
 */
const BOTS = new Set(["dependabot[bot]", "renovate[bot]"]);

interface PullRequest {
  number: number;
  author: string;
  baseRef: string;
  baseSha: string;
}

/** The pull request in a pull_request event's payload (the file at GITHUB_EVENT_PATH). */
function pullRequest(eventPath: string | undefined): PullRequest {
  if (eventPath === undefined) throw new Error("GITHUB_EVENT_PATH isn't set");
  const event: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
  const pr = isRecord(event) ? event["pull_request"] : undefined;
  const user = isRecord(pr) ? pr["user"] : undefined;
  const base = isRecord(pr) ? pr["base"] : undefined;
  if (
    !isRecord(pr) ||
    typeof pr["number"] !== "number" ||
    !isRecord(user) ||
    typeof user["login"] !== "string" ||
    !isRecord(base) ||
    typeof base["ref"] !== "string" ||
    typeof base["sha"] !== "string"
  ) {
    throw new Error(`${eventPath} doesn't describe a pull request`);
  }
  return {
    number: pr["number"],
    author: user["login"],
    baseRef: base["ref"],
    baseSha: base["sha"],
  };
}

/**
 * On GitHub Actions, what a run compares with when it isn't told: a
 * pull_request run's base, or nothing for any other event. Undefined
 * elsewhere.
 */
export function detect(root: string, env: Environment): Detected | undefined {
  if (env["GITHUB_ACTIONS"] !== "true") return undefined;
  const event = env["GITHUB_EVENT_NAME"];
  if (event !== "pull_request") {
    return {
      skip: `Not a pull request (this is a GitHub Actions ${event === undefined ? "" : `${event} `}run), so there's nothing to check. Pass a base revision to check against it anyway.`,
    };
  }
  const pr = pullRequest(env["GITHUB_EVENT_PATH"]);
  if (BOTS.has(pr.author)) {
    return {
      skip: `Pull request #${pr.number} is from ${pr.author}, which updates dependencies a step at a time, so it isn't checked. Pass a base revision to check it anyway.`,
    };
  }
  const label = `${pr.baseRef}, pull request #${pr.number}'s base`;
  const head = resolveCommit(root, "HEAD");
  const [base, other] = parents(root, head);
  // actions/checkout checks out the merge of the pull request into its base
  // by default, so the merge's first parent is the base it was made from.
  // Comparing with that, not the base branch's tip when the event fired,
  // leaves out whatever landed there since.
  if (head === env["GITHUB_SHA"] && base !== undefined && other !== undefined) {
    ensureCommit(root, base);
    return { base, label };
  }
  // The pull request's own head, or something else checked out: compare with
  // where it branched from the base.
  const branched = mergeBase(root, pr.baseSha, head);
  if (branched === undefined) {
    throw new Error(
      `Can't find where HEAD branched from ${pr.baseRef} (${pr.baseSha}); fetch the history (actions/checkout's fetch-depth: 0), or pass the base revision`,
    );
  }
  return { base: branched, label };
}

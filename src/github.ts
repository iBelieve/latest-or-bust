// On GitHub Actions, the base to compare with when none is passed: a
// pull_request run compares with the pull request's base, and any other run
// has nothing to check, nor does a pull request that promotes one branch into
// another (develop into main, say).

import { readFileSync } from "node:fs";
import { DEFAULT_PROMOTIONS, type Promotion } from "./config.ts";
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
  /** Undefined if the payload leaves it out, when it can't be a promotion. */
  headRef: string | undefined;
  headSha: string;
  /** Whether the head branch is in the base's repository rather than a fork. */
  sameRepository: boolean;
}

/** A repository's owner/name in the payload; undefined for a fork that's gone. */
function repository(branch: Record<string, unknown>): string | undefined {
  const repo = branch["repo"];
  return isRecord(repo) && typeof repo["full_name"] === "string" ? repo["full_name"] : undefined;
}

/** The pull request in a pull_request event's payload (the file at GITHUB_EVENT_PATH). */
function pullRequest(eventPath: string | undefined): PullRequest {
  if (eventPath === undefined) throw new Error("GITHUB_EVENT_PATH isn't set");
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch (error) {
    throw new Error(`Can't read the event payload at ${eventPath}`, { cause: error });
  }
  const pr = isRecord(event) ? event["pull_request"] : undefined;
  const user = isRecord(pr) ? pr["user"] : undefined;
  const base = isRecord(pr) ? pr["base"] : undefined;
  const head = isRecord(pr) ? pr["head"] : undefined;
  if (
    !isRecord(pr) ||
    typeof pr["number"] !== "number" ||
    !isRecord(user) ||
    typeof user["login"] !== "string" ||
    !isRecord(base) ||
    typeof base["ref"] !== "string" ||
    typeof base["sha"] !== "string" ||
    !isRecord(head) ||
    typeof head["sha"] !== "string"
  ) {
    throw new Error(`${eventPath} doesn't describe a pull request`);
  }
  return {
    number: pr["number"],
    author: user["login"],
    baseRef: base["ref"],
    baseSha: base["sha"],
    headRef: typeof head["ref"] === "string" ? head["ref"] : undefined,
    headSha: head["sha"],
    sameRepository: repository(head) !== undefined && repository(head) === repository(base),
  };
}

/**
 * On GitHub Actions, what a run compares with when it isn't told: a
 * pull_request run's base, or nothing for any other event, or for a pull
 * request that's one of the promotions. Undefined elsewhere.
 */
export function detect(
  root: string,
  env: Environment,
  promotions: readonly Promotion[] = DEFAULT_PROMOTIONS,
): Detected | undefined {
  if (env["GITHUB_ACTIONS"] !== "true") return undefined;
  const event = env["GITHUB_EVENT_NAME"];
  if (event === "pull_request_target") {
    return {
      skip: "This is a GitHub Actions pull_request_target run, which runs on the pull request's base branch rather than its change, so there's nothing to check. Pass a base revision to check against it anyway.",
    };
  }
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
  // Only a branch in the repository itself: a fork's develop wasn't checked
  // on its way in.
  if (
    pr.sameRepository &&
    promotions.some(({ from, into }) => from === pr.headRef && into === pr.baseRef)
  ) {
    return {
      skip: `Pull request #${pr.number} promotes ${pr.headRef} into ${pr.baseRef}, whose dependencies were checked on their way into ${pr.headRef}, so it isn't checked. Pass a base revision to check it anyway.`,
    };
  }
  const head = resolveCommit(root, "HEAD");
  const [base, other] = parents(root, head);
  // actions/checkout checks out the merge of the pull request into its base
  // by default, so the merge's first parent is the base it was made from.
  // Comparing with that, not the base branch's tip when the event fired,
  // leaves out whatever landed there since. A merge GitHub made again later
  // (checked out by its ref, after the base branch moved) isn't GITHUB_SHA,
  // but its second parent is still the pull request's head.
  if (
    base !== undefined &&
    other !== undefined &&
    (head === env["GITHUB_SHA"] || other === pr.headSha)
  ) {
    ensureCommit(root, base);
    return { base, label: `${pr.baseRef}, pull request #${pr.number}'s base` };
  }
  // The pull request's own head, or something else checked out: compare with
  // where it branched from the base.
  const branched = mergeBase(root, pr.baseSha, head);
  if (branched === undefined) {
    throw new Error(
      `Can't find where HEAD branched from ${pr.baseRef} (${pr.baseSha}); fetch the history (actions/checkout's fetch-depth: 0), or pass the base revision`,
    );
  }
  return { base: branched, label: `where pull request #${pr.number} branched from ${pr.baseRef}` };
}

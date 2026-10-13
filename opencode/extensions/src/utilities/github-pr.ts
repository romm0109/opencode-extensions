import { spawn } from "node:child_process";
import type { PluginContext } from "../plugin-types.ts";

export type PullRequestSummary = {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  reviewDecision: string;
  checks: { passing: number; failing: number; pending: number };
  reviews: { approved: string[]; changesRequested: string[]; commented: string[] };
  comments: number;
};

/** Convert `gh pr view --json` output to stable, credential-free status data. */
export function parsePullRequest(value: unknown): PullRequestSummary {
  if (!isRecord(value) || typeof value.number !== "number" || typeof value.url !== "string") {
    throw new Error("GitHub CLI returned an invalid pull request response.");
  }
  const rollup = Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : [];
  const checks = { passing: 0, failing: 0, pending: 0 };
  for (const item of rollup) {
    if (!isRecord(item)) continue;
    const state = String(item.conclusion ?? item.state ?? "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"].includes(state)) checks.passing += 1;
    else if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(state)) checks.failing += 1;
    else checks.pending += 1;
  }
  const reviews = Array.isArray(value.latestReviews) ? value.latestReviews : [];
  const reviewSummary = { approved: [] as string[], changesRequested: [] as string[], commented: [] as string[] };
  for (const review of reviews) {
    if (!isRecord(review)) continue;
    const login = isRecord(review.author) && typeof review.author.login === "string" ? review.author.login : undefined;
    if (!login) continue;
    if (review.state === "APPROVED") reviewSummary.approved.push(login);
    else if (review.state === "CHANGES_REQUESTED") reviewSummary.changesRequested.push(login);
    else reviewSummary.commented.push(login);
  }
  const state = value.state === "MERGED" || value.mergedAt ? "MERGED" : value.state === "CLOSED" ? "CLOSED" : "OPEN";
  return {
    number: value.number,
    url: value.url,
    state,
    draft: value.isDraft === true,
    reviewDecision: typeof value.reviewDecision === "string" ? value.reviewDecision : "REVIEW_REQUIRED",
    checks,
    reviews: reviewSummary,
    comments:
      isRecord(value.comments) && typeof value.comments.totalCount === "number"
        ? value.comments.totalCount
        : Array.isArray(value.comments)
          ? value.comments.length
          : 0,
  };
}

export function formatPullRequest(status: PullRequestSummary): string {
  return [
    `PR #${status.number}${status.draft ? " · draft" : ""} · ${status.state} · ${status.url}`,
    `Review: ${status.reviewDecision} · approved ${status.reviews.approved.length} · changes requested ${status.reviews.changesRequested.length}`,
    `Checks: ${status.checks.passing} passing · ${status.checks.failing} failing · ${status.checks.pending} pending`,
    `Conversation comments: ${status.comments}`,
  ].join("\n");
}

export async function readCurrentPullRequest(cwd: string, signal?: AbortSignal): Promise<PullRequestSummary> {
  const fields = "number,url,state,isDraft,reviewDecision,latestReviews,statusCheckRollup,comments,mergedAt";
  const output = await runGh(["pr", "view", "--json", fields], cwd, signal);
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("GitHub CLI returned malformed JSON.");
  }
  return parsePullRequest(value);
}

export async function registerGitHubPr(context: PluginContext): Promise<void> {
  await context.command.transform((editor) =>
    editor.add({
      name: "github-pr",
      description: "Show the current branch's GitHub pull request status",
      execute: async ({ sessionID, prompt }) => {
        const args = prompt.text.replace(/^\/github-pr\s*/i, "").trim();
        if (args && args !== "refresh" && args !== "status" && args !== "help") {
          throw new Error("Usage: /github-pr [status | refresh | help]");
        }
        if (args === "help") {
          await context.session.synthetic({
            sessionID,
            text: "Usage: /github-pr [status | refresh | help]\nReads the PR attached to the current Git branch using the authenticated `gh` CLI.",
            resume: false,
          });
          return;
        }
        const status = await readCurrentPullRequest(context.location.directory);
        await context.session.synthetic({ sessionID, text: formatPullRequest(status), resume: false });
      },
    }),
  );
}

export function runGh(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const child = spawn("gh", args, { cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (signal?.aborted) return finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (timedOut) return finish(new Error(`GitHub CLI request timed out after ${timeoutMs} ms.`));
      if (code !== 0)
        return finish(
          new Error(
            `GitHub CLI exited with code ${code ?? "unknown"}. Check ` +
              "`gh auth status`" +
              " and whether the current branch has an associated pull request.",
          ),
        );
      finish(undefined, stdout);
    });
    function finish(error?: Error, value?: string) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value ?? "");
    }
  });
}

function boundedAppend(current: string, next: string): string {
  return (current + next).slice(0, 128_000);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

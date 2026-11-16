// GitHub PR & CI watch (recipe github-ci v1).
//
// Reads a pull request or branch workflow runs through the user's authenticated `gh`
// CLI and emits deterministic event keys so existing failures, reviews, or comments
// establish the initial baseline without firing, and each new item fires once.

type ProbeEvent = { key: string; summary: string; data: Record<string, unknown> };

const ALLOWED_WATCH = new Set(["ci", "ci_pass", "reviews", "comments", "conflicts"]);
const FAIL_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
const PASS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const MAX_EVENTS = 80;

const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const params = input.params ?? {};

const ghBin = String(params.gh_bin || "gh").trim();
const ghHost = String(params.gh_host || "github.com").trim();
const prNumber = Number(params.pr ?? 0);
if (!Number.isInteger(prNumber) || prNumber < 0) {
  throw new Error("probe.params.pr must be 0 (branch mode) or a positive pull request number");
}

const watchList: string[] = Array.isArray(params.watch) ? params.watch : [];
if (watchList.length === 0) {
  throw new Error("probe.params.watch must list at least one of: ci, ci_pass, reviews, comments, conflicts");
}
const unknownWatch = watchList.filter((item) => !ALLOWED_WATCH.has(item));
if (unknownWatch.length > 0) {
  throw new Error("unknown watch item " + unknownWatch.join(", ") + "; use ci, ci_pass, reviews, comments or conflicts");
}
const watchSet = new Set(watchList);
const ignoredActors = new Set(
  (Array.isArray(params.ignore_actors) ? params.ignore_actors : []).map((login: unknown) => String(login).trim().toLowerCase()).filter(Boolean),
);

const decoder = new TextDecoder();

async function runCommand(bin: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(bin, {
      args,
      env: extraEnv,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    throw new Error("could not run " + bin + ": " + (error as Error).message);
  }
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout).trim(),
    stderr: decoder.decode(out.stderr).trim(),
  };
}

async function ghApi<T>(endpoint: string): Promise<T> {
  const res = await runCommand(ghBin, ["api", "--hostname", ghHost, "-H", "Accept: application/vnd.github+json", endpoint]);
  if (res.code !== 0) {
    const detail = res.stderr || res.stdout || ("exit code " + res.code);
    throw new Error("gh api " + endpoint + " failed: " + detail);
  }
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    throw new Error("gh api " + endpoint + " returned non-JSON output");
  }
}

function clip(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

let repo = String(params.repo ?? "").trim();
if (repo) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error('probe.params.repo must look like "OWNER/REPO"');
  }
} else {
  const viewed = await runCommand(ghBin, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { GH_HOST: ghHost });
  if (viewed.code !== 0 || !/^[^/\s]+\/[^/\s]+$/.test(viewed.stdout)) {
    throw new Error('could not infer GitHub repository from target.cwd; set probe.params.repo to "OWNER/REPO"');
  }
  repo = viewed.stdout;
}

const events: ProbeEvent[] = [];
const pushEvent = (event: ProbeEvent) => {
  if (events.length < MAX_EVENTS && !events.some((existing) => existing.key === event.key)) {
    events.push(event);
  }
};

if (prNumber > 0) {
  type PullResponse = {
    number: number;
    state: string;
    merged: boolean;
    title: string;
    html_url: string;
    mergeable: boolean | null;
    mergeable_state?: string;
    head: { sha: string; ref: string };
  };
  const pr = await ghApi<PullResponse>("repos/" + repo + "/pulls/" + prNumber);
  const headSha = pr.head.sha;
  const shortSha = headSha.slice(0, 7);
  const shaKey = headSha.slice(0, 12);
  let checkSummary = "checks not watched";

  if (watchSet.has("ci") || watchSet.has("ci_pass")) {
    type CheckRun = { id: number; name: string; status: string; conclusion: string | null; html_url?: string; details_url?: string };
    type CombinedStatus = { statuses?: Array<{ context: string; state: string; description?: string; target_url?: string }> };
    const [checksResp, statusResp] = await Promise.all([
      ghApi<{ check_runs?: CheckRun[] }>("repos/" + repo + "/commits/" + headSha + "/check-runs?per_page=100"),
      ghApi<CombinedStatus>("repos/" + repo + "/commits/" + headSha + "/status"),
    ]);
    const checkRuns = Array.isArray(checksResp.check_runs) ? checksResp.check_runs : [];
    const latestStatuses = new Map<string, { context: string; state: string; description?: string; target_url?: string }>();
    for (const st of Array.isArray(statusResp.statuses) ? statusResp.statuses : []) {
      if (st.context && !latestStatuses.has(st.context)) latestStatuses.set(st.context, st);
    }

    let failing = 0;
    let pending = 0;
    for (const run of checkRuns) {
      if (run.status !== "completed") {
        pending += 1;
        continue;
      }
      const conclusion = run.conclusion ?? "";
      if (FAIL_CONCLUSIONS.has(conclusion)) {
        failing += 1;
        if (watchSet.has("ci")) {
          pushEvent({
            key: "check-fail:" + repo + ":pr-" + prNumber + ":" + run.id,
            summary: repo + "#" + prNumber + " · check failed: " + run.name + " (" + conclusion + ")",
            data: {
              repo,
              pr: prNumber,
              head_sha: headSha,
              check_id: run.id,
              name: run.name,
              conclusion,
              url: run.html_url ?? run.details_url ?? pr.html_url,
            },
          });
        }
      } else if (!PASS_CONCLUSIONS.has(conclusion)) {
        pending += 1;
      }
    }

    for (const st of latestStatuses.values()) {
      if (st.state === "pending") {
        pending += 1;
      } else if (st.state === "failure" || st.state === "error") {
        failing += 1;
        if (watchSet.has("ci")) {
          const safeContext = st.context.slice(0, 80);
          pushEvent({
            key: "status-fail:" + repo + ":pr-" + prNumber + ":" + shaKey + ":" + safeContext,
            summary: repo + "#" + prNumber + " · status " + st.state + ": " + st.context,
            data: {
              repo,
              pr: prNumber,
              head_sha: headSha,
              context: st.context,
              state: st.state,
              description: st.description ?? "",
              url: st.target_url ?? pr.html_url,
            },
          });
        }
      }
    }

    const total = checkRuns.length + latestStatuses.size;
    if (total === 0) {
      checkSummary = "no checks on " + shortSha;
    } else if (failing > 0) {
      checkSummary = failing + " failing, " + pending + " pending of " + total + " check(s) on " + shortSha;
    } else if (pending > 0) {
      checkSummary = pending + " of " + total + " check(s) pending on " + shortSha;
    } else {
      checkSummary = "all " + total + " check(s) passed on " + shortSha;
      if (watchSet.has("ci_pass")) {
        pushEvent({
          key: "pr-ci-pass:" + repo + ":pr-" + prNumber + ":" + shaKey,
          summary: repo + "#" + prNumber + " · all " + total + " check(s) passed on " + shortSha,
          data: { repo, pr: prNumber, head_sha: headSha, total_checks: total, url: pr.html_url },
        });
      }
    }
  }

  if (watchSet.has("conflicts") && pr.state === "open" && (pr.mergeable === false || pr.mergeable_state === "dirty")) {
    pushEvent({
      key: "conflict:" + repo + ":pr-" + prNumber + ":" + shaKey,
      summary: repo + "#" + prNumber + " · merge conflicts on " + pr.head.ref + " (" + shortSha + ")",
      data: { repo, pr: prNumber, branch: pr.head.ref, head_sha: headSha, mergeable_state: pr.mergeable_state ?? "dirty", url: pr.html_url },
    });
  }

  if (watchSet.has("reviews")) {
    type Review = { id: number; state: string; body?: string | null; submitted_at?: string; html_url?: string; user?: { login?: string } | null };
    const reviews = await ghApi<Review[]>("repos/" + repo + "/pulls/" + prNumber + "/reviews?per_page=50");
    for (const review of Array.isArray(reviews) ? reviews.slice().reverse() : []) {
      const actor = review.user?.login ?? "unknown";
      if (ignoredActors.has(actor.toLowerCase())) continue;
      if (review.state === "PENDING" || review.state === "DISMISSED") continue;
      const body = (review.body ?? "").trim();
      if (review.state === "COMMENTED" && body === "") continue;
      const detail = body ? ": " + clip(body, 90) : "";
      pushEvent({
        key: "review:" + repo + ":pr-" + prNumber + ":" + review.id,
        summary: repo + "#" + prNumber + " · review by @" + actor + " (" + review.state + ")" + detail,
        data: {
          repo,
          pr: prNumber,
          review_id: review.id,
          user: actor,
          state: review.state,
          body: clip(body, 400),
          submitted_at: review.submitted_at ?? null,
          url: review.html_url ?? pr.html_url,
        },
      });
    }
  }

  if (watchSet.has("comments")) {
    type ReviewComment = { id: number; path?: string; line?: number | null; original_line?: number | null; body?: string; created_at?: string; html_url?: string; user?: { login?: string } | null };
    type IssueComment = { id: number; body?: string; created_at?: string; html_url?: string; user?: { login?: string } | null };
    const [diffComments, issueComments] = await Promise.all([
      ghApi<ReviewComment[]>("repos/" + repo + "/pulls/" + prNumber + "/comments?sort=created&direction=desc&per_page=30"),
      ghApi<IssueComment[]>("repos/" + repo + "/issues/" + prNumber + "/comments?per_page=30"),
    ]);

    for (const comment of Array.isArray(diffComments) ? diffComments : []) {
      const actor = comment.user?.login ?? "unknown";
      if (ignoredActors.has(actor.toLowerCase())) continue;
      const body = (comment.body ?? "").trim();
      const loc = comment.path ? (comment.line ?? comment.original_line ? comment.path + ":" + (comment.line ?? comment.original_line) : comment.path) : "diff";
      pushEvent({
        key: "review-comment:" + repo + ":pr-" + prNumber + ":" + comment.id,
        summary: repo + "#" + prNumber + " · @" + actor + " on " + loc + ": " + clip(body, 80),
        data: {
          repo,
          pr: prNumber,
          comment_id: comment.id,
          kind: "review_comment",
          user: actor,
          path: comment.path ?? null,
          line: comment.line ?? comment.original_line ?? null,
          body: clip(body, 400),
          created_at: comment.created_at ?? null,
          url: comment.html_url ?? pr.html_url,
        },
      });
    }

    for (const comment of Array.isArray(issueComments) ? issueComments.slice().reverse() : []) {
      const actor = comment.user?.login ?? "unknown";
      if (ignoredActors.has(actor.toLowerCase())) continue;
      const body = (comment.body ?? "").trim();
      pushEvent({
        key: "issue-comment:" + repo + ":pr-" + prNumber + ":" + comment.id,
        summary: repo + "#" + prNumber + " · @" + actor + " commented: " + clip(body, 90),
        data: {
          repo,
          pr: prNumber,
          comment_id: comment.id,
          kind: "issue_comment",
          user: actor,
          body: clip(body, 400),
          created_at: comment.created_at ?? null,
          url: comment.html_url ?? pr.html_url,
        },
      });
    }
  }

  console.log(
    JSON.stringify({
      events,
      summary: repo + "#" + prNumber + " (" + pr.state + ", " + shortSha + "): " + checkSummary + "; " + events.length + " tracked item(s)",
    }),
  );
} else {
  let branch = String(params.branch ?? "").trim();
  if (!branch) {
    const gitBranch = await runCommand("git", ["branch", "--show-current"]);
    if (gitBranch.code === 0 && gitBranch.stdout) {
      branch = gitBranch.stdout;
    } else {
      const repoInfo = await ghApi<{ default_branch?: string }>("repos/" + repo);
      branch = repoInfo.default_branch ?? "main";
    }
  }

  const workflow = String(params.workflow ?? "").trim();
  const commit = await ghApi<{ sha: string }>("repos/" + repo + "/commits/" + encodeURIComponent(branch));
  const headSha = commit.sha;
  const shortSha = headSha.slice(0, 7);

  type WorkflowRun = {
    id: number;
    workflow_id?: number;
    name?: string;
    run_number: number;
    run_attempt?: number;
    created_at: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    html_url: string;
  };
  const runsPath = workflow
    ? "repos/" + repo + "/actions/workflows/" + encodeURIComponent(workflow) + "/runs?branch=" + encodeURIComponent(branch) + "&per_page=25"
    : "repos/" + repo + "/actions/runs?branch=" + encodeURIComponent(branch) + "&per_page=25";
  const runsResp = await ghApi<{ workflow_runs?: WorkflowRun[] }>(runsPath);
  const allRuns = (Array.isArray(runsResp.workflow_runs) ? runsResp.workflow_runs : []).slice().sort((a, b) => {
    const timeDiff = Date.parse(b.created_at) - Date.parse(a.created_at);
    return timeDiff !== 0 ? timeDiff : b.run_number - a.run_number;
  });

  // Order by creation time / run number per workflow, then inspect only runs still on the branch's current head commit.
  const latestByWorkflow = new Map<string, WorkflowRun>();
  for (const run of allRuns) {
    const key = String(run.workflow_id ?? run.name ?? run.id);
    if (!latestByWorkflow.has(key)) latestByWorkflow.set(key, run);
  }
  const currentHeadRuns = [...latestByWorkflow.values()].filter((run) => run.head_sha === headSha);

  let failing = 0;
  let pending = 0;
  for (const run of currentHeadRuns) {
    const attempt = run.run_attempt ?? 1;
    const wfName = run.name ?? (workflow || "workflow");
    if (run.status !== "completed") {
      pending += 1;
      continue;
    }
    const conclusion = run.conclusion ?? "";
    if (FAIL_CONCLUSIONS.has(conclusion)) {
      failing += 1;
      if (watchSet.has("ci")) {
        pushEvent({
          key: "ci-fail:" + repo + ":" + run.id + ":" + attempt,
          summary: repo + "@" + branch + " · " + wfName + " #" + run.run_number + " (attempt " + attempt + ") " + conclusion,
          data: {
            repo,
            branch,
            workflow: wfName,
            run_id: run.id,
            run_number: run.run_number,
            run_attempt: attempt,
            head_sha: headSha,
            conclusion,
            url: run.html_url,
          },
        });
      }
    } else if (!PASS_CONCLUSIONS.has(conclusion)) {
      pending += 1;
    }
  }

  if (watchSet.has("ci_pass") && currentHeadRuns.length > 0 && failing === 0 && pending === 0) {
    const wfPart = workflow ? ":" + workflow : "";
    pushEvent({
      key: "ci-pass:" + repo + ":" + branch + wfPart + ":" + headSha.slice(0, 12),
      summary: repo + "@" + branch + " · all " + currentHeadRuns.length + " workflow(s) passed on " + shortSha,
      data: {
        repo,
        branch,
        workflow: workflow || null,
        head_sha: headSha,
        workflows: currentHeadRuns.map((r) => ({ name: r.name ?? "workflow", run_id: r.id, url: r.html_url })),
      },
    });
  }

  const statusText =
    currentHeadRuns.length === 0
      ? "no workflow runs yet on " + shortSha
      : failing > 0
        ? failing + " failing, " + pending + " running of " + currentHeadRuns.length + " workflow(s) on " + shortSha
        : pending > 0
          ? pending + " of " + currentHeadRuns.length + " workflow(s) running on " + shortSha
          : "all " + currentHeadRuns.length + " workflow(s) passed on " + shortSha;

  console.log(JSON.stringify({ events, summary: repo + "@" + branch + ": " + statusText }));
}

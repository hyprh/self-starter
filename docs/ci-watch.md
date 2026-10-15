# Investigate a new CI failure

Ask Codex to watch a GitHub Actions workflow and return to this conversation when a new failure needs attention. Self-Starter runs a small code probe while it waits; Codex reads the failure and investigates when the event fires.

This uses the existing custom-event flow. There is no CI recipe to install.

## Try it

Install [Self-Starter](../README.md#install), open your project in Codex, and make sure the [GitHub CLI](https://cli.github.com/) can read the repository and its Actions runs. On your own machine, use `gh auth login` for a persistent login; a token exported only in a terminal may not reach the background service.

Start with Codex open so you can see the event arrive. Replace `OWNER/REPO`, the workflow filename and branch in this request:

> Watch push-triggered runs of the `ci.yml` workflow in `OWNER/REPO` on `main` for 24 hours, checking every two minutes. If the newest run is still on the branch's current commit and has failed or timed out, report each newly observed run attempt once in this conversation. Recheck that it is still current, read that attempt's failing job logs, and suggest a fix. Notify me when the analysis is ready. Keep the investigation read-only: do not edit files, rerun workflows or push changes.

Codex writes the probe, tries it once, and shows what it will watch. Confirm the repository, workflow, expiry and destination conversation before starting it. The same request can be adapted to another branch, a particular PR or a different condition.

For a repeating watch, explicitly ask for **this conversation** as above: repeating triggers otherwise use a dedicated conversation by default.

## What to expect

1. The first successful check after activation establishes a baseline. Existing failures do not trigger an investigation. Wait for this check before testing a new event.
2. Subsequent checks run as code, without calling a model. A newly observed failed attempt triggers the task only if it is still the newest run on the branch's current commit when checked. Failures superseded between polls may not be reported. Repeated sightings of the same attempt are deduplicated.
3. Codex rechecks whether that run attempt and commit are still current, then reads the matching attempt's logs and reports its findings. A newer successful or running CI should prevent an old failure from being treated as the current problem.
4. The result appears in the chosen conversation. Desktop notifications require a working notification service on the machine running Self-Starter.

Ask Codex to show the watch's recent checks and history if nothing happens. You can also use `~/.self-starter/bin/self-starter list` and `~/.self-starter/bin/self-starter history`. Pause or delete the watch when you are finished; this example also expires after 24 hours.

Keep the machine awake and connected. Self-Starter can resume a closed Codex conversation in the background, but that turn still needs access to GitHub to fetch logs. Network access is disabled by default in Codex's `workspace-write` sandbox; your existing configuration may differ. A background turn cannot obtain an interactive approval. Verify the analysis environment's network permissions before relying on unattended investigation; a successful probe alone does not establish that the later Codex turn can read GitHub.

## Check the generated watch

Check that Codex creates an **event-mode** watch, so the engine can establish the initial baseline and deduplicate run attempts. A probe that launches `gh` needs `probe.access: full`; the network-only probe sandbox cannot run commands. Its access is separate from the later Codex investigation's permissions. The probe can use `gh api` to read the workflow's runs. It should:

- Select the latest push-triggered run for the intended workflow and branch from all statuses, ordered by creation time or run number. A rerun can update an old run's `updated_at`, so do not use that field to decide which run is newest. Confirm its `head_sha` still matches the branch head, then check for a completed `failure` or `timed_out` conclusion. Fetching only failed runs can keep an old failure visible after CI recovers.
- Identify events by repository, run ID and `run_attempt`, so a failed rerun of the current run is a new event. Keep the run ID, attempt and commit in the event data. Before analysis, recheck all three and read logs for that exact attempt, since a queued event can become stale or the run may have been rerun.
- Treat a failed request as a failed check. An authentication or network error does not mean CI passed. Cancelled jobs and workflows awaiting approval also need different handling from test failures.

For example, this read-only command lists recent runs, including successes and runs still in progress:

```sh
gh api --hostname github.com \
  repos/OWNER/REPO/actions/workflows/ci.yml/runs \
  --method GET --raw-field branch=main --raw-field event=push \
  --raw-field per_page=20 \
  --jq '.workflow_runs[] | {id, run_number, run_attempt, created_at, head_sha, status, conclusion, html_url}'
```

The `event=push` filter suits branch CI triggered by pushes. A workflow triggered by `pull_request` needs a matching query and the intended PR identity instead.

## How this relates to Codex's own CI tools

OpenAI publishes the [`gh-fix-ci` skill](https://github.com/openai/skills/blob/main/skills/.curated/gh-fix-ci/SKILL.md) for Codex to read failed checks, investigate logs and plan fixes. Codex also supports [scheduled checks and follow-ups in an existing thread](https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/openai-docs/references/codex-self-knowledge.md).

This example shows Self-Starter's code-based waiting and event rules. CI analysis itself uses Codex's existing capabilities. The probe can be changed to fit a different condition, and the same engine handles event deduplication, cooldowns and expiry.

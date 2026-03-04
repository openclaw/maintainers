# Maintainer Onboarding

Start here:

- Read [`VISION`](https://github.com/openclaw/openclaw/blob/main/VISION.md) and [`CONTRIBUTING`](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md) in `openclaw/openclaw`.
- Then read [`PR_WORKFLOW.md`](.agents/skills/PR_WORKFLOW.md) for how to process PRs.

## PR Operations Tooling

This is a queue and tracking layer for maintainers.

- It decides what to review next (dedupe-first queue).
- It prepares Codex/Claude handoff context for that PR.
- It records what you actually did (merge/close/defer) so the queue keeps moving.
- It does not merge or close PRs on GitHub directly. Your reviewer agent does that.
- Script defaults are cwd-agnostic: when paths are not overridden, they resolve relative to this
  `maintainers` repo (so running `../maintainers/scripts/*` from `openclaw` works).

### Quickstart (30 seconds)

```bash
scripts/pr-plan
scripts/pr-next
scripts/pr-handoff --tool codex
```

- Copy `pr-handoff` output into Codex/Claude and complete review/merge/close in `openclaw`.
- Record the final outcome in pr-ops:
  `scripts/pr-decide --decision <merge|close_duplicate|close_not_planned|defer> --pr <number>`
- Check progress with `scripts/pr-stats`.

### Responsibilities

- Reviewer agent (`openclaw` repo):
  - run `review-pr` -> `prepare-pr` -> `merge-pr`
  - perform GitHub write actions (merge/close)
- pr-ops (`maintainers` repo):
  - plan queue
  - generate handoff prompt
  - track decisions and progress state
  - no direct GitHub write actions

### Daily Workflow (Simple)

1. Build or refresh the queue:

```bash
scripts/pr-plan
```

`scripts/pr-plan` is cache-first:

- if `.local/pr-plan/open-prs.jsonl` exists, it reuses cache
- if cache is missing, it fetches once and writes cache

Use flags when needed:

- `scripts/pr-plan --use-cache` (cache only, fail if missing)
- `scripts/pr-plan --live` (GitHub refresh; incremental from cache watermark when possible)

`--live` now does incremental refresh against `open-prs.jsonl` and periodically falls back to a full sync
(currently every 24 hours) to keep stale closed PRs from lingering in cache.

2. Get next item + handoff prompt:

```bash
scripts/pr-next
scripts/pr-handoff --tool codex
```

`scripts/pr-next` performs a live GitHub status check for candidate PRs and skips items whose representative PR is already closed/merged.
`scripts/pr-handoff` defaults to prompt-only output (exact copy/paste text for Codex/Claude).
Use `--verbose` for extra metadata/operator hints or `--json` for machine-readable payloads.

3. In `openclaw`, review with your normal Codex/Claude skill flow and perform merge/close there.

4. Mirror final action in state:

```bash
# merged origin PR
scripts/pr-decide --decision merge --pr <origin_pr>

# merged origin PR and automatically recorded duplicate-member closures
scripts/pr-decide --decision merge --pr <origin_pr> --auto-close-duplicates

# merged a non-origin cluster member and auto-closed all other members
scripts/pr-decide --decision merge --pr <merged_cluster_member_pr> --auto-close-duplicates

# closed duplicate members for that origin cluster
scripts/pr-decide --decision close_duplicate --pr <origin_pr>

# closed as not planned
scripts/pr-decide --decision close_not_planned --pr <pr_number>
```

5. Track progress:

```bash
scripts/pr-stats
```

State persists in `pr-ops/state/decisions.jsonl`, so rerunning `scripts/pr-next` resumes from the next unresolved item.

### Parallel Agent Workflow

Use claims to split queue work across multiple agents without collisions.

1. Set owner once per agent session (recommended):

```bash
export PR_OPS_OWNER=codex-a
```

2. Get claim-aware next item and handoff:

```bash
scripts/pr-next
scripts/pr-handoff --tool codex
```

`scripts/pr-handoff` defaults to prompt-only output. Add `--verbose` when you want extra context lines.

3. After review action in `openclaw`, record decisions as normal:

```bash
scripts/pr-decide --decision merge --pr <merged_pr> --auto-close-duplicates
```

Claim behavior:

- `pr-next` auto-claims the selected PR for the resolved owner.
- `pr-next` live-checks candidate PR state and skips stale closed/merged representatives.
- Claims are lease-based (`--ttl-minutes`, default 120).
- `pr-next` and `pr-handoff` skip items claimed by other owners.
- `--owner` is optional. If omitted, scripts use `PR_OPS_OWNER`, then `USER`.
- If no owner resolves, `pr-next`/`pr-handoff` return only unclaimed items.

### Cluster Behavior

- If a PR is a cluster origin, handoff includes `origin`, `cluster_members`, and `pending_members`.
- `merge` auto-applies to only the selected PR.
- `merge --auto-close-duplicates` records `close_duplicate` for every other unresolved member in that cluster (origin or non-origin).
- `close_duplicate` auto-applies to duplicate members in the cluster (excluding origin).
- `close_not_planned` auto-applies to only the selected PR.
- `--single` and `--exclude-representative` remain available as manual overrides.

### Handoff Context Coverage

Yes, `pr-handoff` includes the important duplicate context you captured:

- lane (`cluster`/`fast`/`deep`)
- representative PR + URL
- origin PR
- cluster members
- pending (unresolved) members
- policy flags
- queue rationale
- skill-routed action policy and structured return format
- explicit boundary: reviewer agent does GitHub actions; operator runs `pr-decide` in pr-ops

### Example Handoff Output

```text
Review this PR and take a final maintainer action.
Repository: openclaw/openclaw
PR: https://github.com/openclaw/openclaw/pull/32831
PR Number: #32831
Title: fix(gateway): ...
Queue lane: cluster
Origin PR: #32831
Cluster members: 32831, 32848
Pending members: 32831, 32848
Policy flags: none
Queue rationale: exact title cluster (2 PRs) | file overlap confidence: high | origin PR: #32831
```

### Troubleshooting

- `Plan file not found .../.local/pr-plan/daily-plan.json`
  - Run `scripts/pr-plan` first.
  - If you run commands from `openclaw`, defaults still resolve to `../maintainers` paths.
- `No unclaimed queue items available for this owner`
  - Set owner explicitly (`export PR_OPS_OWNER=<id>`) or wait for claim TTL expiry.
  - Use `scripts/pr-stats` to inspect active claims.
- `.local/prep.env` missing during merge flow
  - `merge-pr` includes a built-in manual prep-head push recovery step to regenerate it.
- Need operator hints in handoff output
  - Use `scripts/pr-handoff --tool codex --verbose` (default output is prompt-only).

Artifacts:

- `.local/pr-plan/analysis.json`
- `.local/pr-plan/clusters.json`
- `.local/pr-plan/cluster-refinements.json`
- `.local/pr-plan/daily-plan.json`
- `.local/pr-plan/daily-plan.md`
- `.local/pr-plan/daily-queue.tsv`
- `.local/pr-plan/open-prs-meta.json`
- `.local/pr-plan/pr-live-status-cache.json`
- `.local/pr-plan/pr-files-cache.json`
- `pr-ops/state/decisions.jsonl` (persistent decision log)
- `pr-ops/state/claims.jsonl` (lease-based claim log for multi-agent assignment)

`daily-queue.tsv` includes `origin_number`, `cluster_confidence`, `cluster_coverage`, and
`policy_flags` to help decide whether to fan out a duplicate decision or treat items individually.

Implementation layout:

- `scripts/pr-plan.ts`: thin CLI entrypoint and stable exports used by tests.
- `scripts/pr-plan`: workflow command wrapper.
- `scripts/pr-next.ts`: choose the next unresolved queue item and auto-claim it for the active owner.
- `scripts/pr-handoff.ts`: emit Codex/Claude handoff prompt with queue context.
- `scripts/pr-decide.ts`: persist a decision and optionally fan out to cluster members.
- `scripts/pr-stats.ts`: show daily progress and decision-gain metrics.
- `pr-ops/core/types.ts`: shared types.
- `pr-ops/core/constants.ts`: scoring/policy constants and regexes.
- `pr-ops/github/client.ts`: GitHub API + cache I/O.
- `pr-ops/core/clustering.ts`: title clustering + diff-overlap refinements.
- `pr-ops/core/planning.ts`: lane planning and policy-flag attachment.
- `pr-ops/core/policy.ts`: vendor/default-path policy detector.
- `pr-ops/core/analysis.ts`: snapshot aggregation.
- `pr-ops/cli/render.ts`: markdown + TSV artifact rendering.
- `pr-ops/state/decisions.ts`: decision log/state, queue progression, and stats helpers.
- `pr-ops/state/claims.ts`: claim log/state helpers for multi-agent queue coordination.

Current policy flags:

- `vendor_lockin_default_path`: vendor integration affects default onboarding/runtime paths
- `auto_enable_vendor_tools`: vendor tools are auto-enabled in core flow
- `default_profile_shift`: browser/profile defaults shift toward a vendor
- `vendor_core_not_optional`: vendor behavior lands in core runtime without explicit opt-in framing

Policy flags are strict by design: they trigger only when vendor-related changes also touch
default-path surfaces (onboarding/browser defaults/core tool defaults), to reduce false positives.

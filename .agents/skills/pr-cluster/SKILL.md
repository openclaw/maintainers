---
name: pr-cluster
description: "Find clusters of related PRs given a PR number. Identifies duplicates, similar fixes, and competing approaches across 5K+ open PRs using GitHub Search API. Use when reviewing a PR, triaging, or looking for duplicate/related PRs. Run this before /review-pr to find the full cluster first."
argument-hint: "<PR-number> [owner/repo]"
allowed-tools: Bash(gh api:*), Bash(gh pr:*), Bash(gh search:*), Bash(git log:*), Bash(git show:*)
---

# PR Cluster Finder

Find clusters of related PRs so you can review them as a group, identify the best base PR, and close duplicates. This is the **pre-review triage step** — run before `/review-pr`.

> "Think in Clusters, Not Individual PRs. A single good merge often resolves 5+ related issues and PRs at once."

## Arguments

- `$1` = PR number (required)
- `$2` = owner/repo (default: auto-detect from `gh repo view --json nameWithOwner -q .nameWithOwner`, falls back to `openclaw/openclaw`)

## Output Rules

- **Always include clickable GitHub links** for every PR and issue mentioned in the report: `https://github.com/{owner}/{repo}/pull/{number}` for PRs, `https://github.com/{owner}/{repo}/issues/{number}` for issues.
- Use markdown link format: `[**#123**: title](url)` so links are clickable in terminal and rendered output.

## Workflow

### Phase 1: Analyze the Target PR

Fetch the target PR's full details. Run these in parallel:

```bash
# PR metadata
gh api repos/{owner}/{repo}/pulls/{number} \
  --jq '{number, title, state, body, user: .user.login, created_at, updated_at, comments, review_comments, labels: [.labels[].name], mergeable_state}'

# Files changed
gh api repos/{owner}/{repo}/pulls/{number}/files \
  --jq '[.[] | {filename, status, additions, deletions}]'

# Reviews
gh api repos/{owner}/{repo}/pulls/{number}/reviews \
  --jq '[.[] | {user: .user.login, state}]'
```

Extract these **clustering signals** from the response:

1. **Conventional commit scope** — parse `type(scope): description` from title → extract `scope` (e.g., `telegram`, `discord`, `gateway`). This is the strongest signal.
2. **Keywords** — 3-5 meaningful words from the title after stripping the type/scope prefix and stop words.
3. **Labels** — especially `channel: *` and `size: *` labels.
4. **Files changed** — exact file paths. Strong duplicate signal.
5. **Directories touched** — parent directories of changed files (e.g., `src/telegram/`).
6. **Issue references** — scan body for `#NNNN`, `fixes #NNNN`, `closes #NNNN`, `issue #NNNN` patterns.

### Phase 2: Multi-Signal Search

Run **all searches in parallel** — they're independent. Use `per_page=30` and `sort=updated&order=desc` for broad searches.

**Search 1 — Same channel/scope label:**
```bash
gh api 'search/issues?q=repo:{owner}/{repo}+is:pr+label:"{label}"&per_page=30&sort=updated&order=desc' \
  --jq '[.items[] | {number, title, state, user: .user.login, updated_at, labels: [.labels[].name]}]'
```

**Search 2 — Title keywords** (catches different approaches to same problem):
```bash
gh api 'search/issues?q=repo:{owner}/{repo}+is:pr+{keyword1}+{keyword2}+{keyword3}&per_page=30&sort=updated&order=desc' \
  --jq '[.items[] | {number, title, state, user: .user.login, updated_at}]'
```

**Search 3 — File-path keywords** (catches direct duplicates):
For each distinctive file changed, search using the filename stem (without extension):
```bash
gh api 'search/issues?q=repo:{owner}/{repo}+is:pr+{filename-stem}&per_page=20' \
  --jq '[.items[] | {number, title, state, user: .user.login}]'
```
Then verify file overlap on top candidates:
```bash
gh api repos/{owner}/{repo}/pulls/{candidate}/files --jq '[.[].filename]'
```

**Search 4 — Linked issues** (catches PRs targeting the same bug):
For each issue `#NNNN` referenced in the target PR body:
```bash
gh api 'search/issues?q=repo:{owner}/{repo}+is:pr+{issue_number}&per_page=20' \
  --jq '[.items[] | {number, title, state, user: .user.login}]'
```

**Search 5 — Scope in title** (broadest catch for same subsystem):
```bash
gh api 'search/issues?q=repo:{owner}/{repo}+is:pr+in:title+{scope}&per_page=30&sort=updated&order=desc' \
  --jq '[.items[] | {number, title, state, user: .user.login, updated_at}]'
```

**Important — PR state handling:** All searches include both open and closed PRs. For each result, capture the `state` field (`open` or `closed`). For closed PRs, check if they were merged using `gh api repos/{owner}/{repo}/pulls/{number} --jq '.merged'`. Use these status badges in the report:
- `OPEN` — still open
- `MERGED` — closed and merged (the fix landed; this may mean the problem is already solved!)
- `CLOSED` — closed without merge (rejected or abandoned approach — note why if comments explain)

For `CLOSED` PRs, **read the closing comments** (`gh api repos/{owner}/{repo}/issues/{number}/comments --jq '.[].body'`). Look for:
- References to landed commits (e.g., `559b5eab7`) — these mean the fix shipped via a different path. Always link landed commits as `https://github.com/{owner}/{repo}/commit/{sha}`.
- "Duplicate of #NNNN" — follow the chain to the actual resolution.
- "Reimplemented on main" — the PR's approach was adopted but re-done by a maintainer.
- Stale/inactivity closures — the PR may still be valid, just abandoned.

This is critical context: a closed PR with a landed commit often means **the problem is already solved and all open duplicates should be closed too.**

### Phase 3: Score and Cluster

Deduplicate all results by PR number (exclude the target PR itself). For each candidate, calculate a relevance score:

| Signal | Points | Notes |
|--------|--------|-------|
| Shared file | +3 each | Same files = likely duplicate |
| Same issue ref | +5 | Explicitly same bug |
| Shared label | +2 each | Same channel/scope |
| Title keyword overlap | +1 each | Similar problem space |
| Same commit scope | +2 | Same subsystem |
| Updated in last 30 days | +1 | Active, not stale |
| Has reviews | +1 | Already received attention |
| `maintainer` or `trusted-contributor` label | +1 | Higher quality signal |

**Tier assignment:**
- **Tier 1 — Likely duplicates** (score >= 8): Almost certainly addressing the same problem.
- **Tier 2 — Strongly related** (score 4-7): Same area, possibly different aspects.
- **Tier 3 — Loosely related** (score 2-3): Same subsystem, different issues.

### Phase 4: Deep Dive on Top Candidates

For Tier 1 and Tier 2 PRs (up to ~15), fetch full details:

```bash
gh api repos/{owner}/{repo}/pulls/{number} \
  --jq '{number, title, state, body: (.body[:500]), user: .user.login, created_at, updated_at, additions, deletions, comments, review_comments, mergeable_state, labels: [.labels[].name]}'
```

Evaluate each PR on:
- **Problem match**: Is it solving the exact same problem as the target?
- **Completeness**: Does it fully solve the problem or is it partial?
- **Size**: additions/deletions, size label (smaller focused fixes are preferred)
- **Freshness**: Last updated, staleness (>90 days = likely superseded)
- **Author trust**: `maintainer` > `trusted-contributor` > `experienced-contributor` > unlabeled
- **Review status**: Approved? Changes requested? No reviews?
- **Quality signals**: Does the PR body explain the problem clearly? Are there tests?

Remember: **Treat PRs as problem descriptions, not finished code.** The best PR to base from may not have the best code — it might just describe the problem most clearly or touch the right files.

### Phase 5: Cluster Report

Present results in this format:

```
## PR Cluster Report: #{target_number}

### Target PR
[**#{number}**: {title}](https://github.com/{owner}/{repo}/pull/{number})
- Author: @{author} | Labels: {labels} | Files: {count} changed
- Problem: {1-2 sentence summary from PR body}

### Cluster Summary
{N} related PRs found | {T1} likely duplicates | {T2} strongly related | {T3} loosely related

---

### Tier 1: Likely Duplicates (score >= 8)

`{STATUS}` [**#{number}**: {title}](https://github.com/{owner}/{repo}/pull/{number})
- Author: @{author} | Updated: {date} | Size: {label} | Reviews: {count}
- Shared files: {list}
- Why duplicate: {specific reason — same fix, same issue, same files}
- Quality: {brief assessment}

[repeat for each]

If any Tier 1 PR is MERGED, flag prominently: "This fix may already be on main — verify before proceeding."

### Tier 2: Strongly Related (score 4-7)

`{STATUS}` [**#{number}**: {title}](https://github.com/{owner}/{repo}/pull/{number})
- Author: @{author} | Updated: {date}
- Connection: {what connects it to the target}

[repeat for each]

### Tier 3: Loosely Related (score 2-3)

- `{STATUS}` [#{number}: {title}](https://github.com/{owner}/{repo}/pull/{number}) — {one-line connection}
[brief list]

---

### Recommendation

**Best base PR**: [#{number}](https://github.com/{owner}/{repo}/pull/{number}) — {why this one}
- Consider: {what makes it the strongest starting point — freshness, completeness, author trust, code quality}

**Close if best is merged**: [#{n1}](https://github.com/{owner}/{repo}/pull/{n1}), [#{n2}](...) — {these are superseded}
**Keep open** (different enough to warrant separate review): [#{n}](https://github.com/{owner}/{repo}/pull/{n})
**Related issues**: [#{issue}](https://github.com/{owner}/{repo}/issues/{issue}) — {include all issue refs found during search}

**Suggested next step**: `/review-pr {best_number}` to begin the review pipeline on the best candidate.
**Duplicate cleanup**: After merging, close superseded PRs with a polite comment thanking the contributor and linking to the merged PR.
```

## Integration with Maintainer Pipeline

This skill is **Step 0** in the maintainer workflow:

```
/pr-cluster {number}  →  find the cluster, pick the best base
/review-pr {best}     →  structured review with findings
/prepare-pr {best}    →  rebase, fix findings, run gates, push
/merge-pr {best}      →  squash-merge with attribution
→ close duplicates from the cluster
```

After identifying the best candidate, hand off to `/review-pr` which will:
- Create a worktree at `.worktrees/pr-{number}`
- Run `scripts/pr-review` for setup
- Produce `.local/review.md` and `.local/review.json` with structured findings

The cluster context you gather here informs the review — mention duplicate PRs and alternative approaches in the review findings so `/prepare-pr` can incorporate the best ideas from across the cluster.

## Rate Limits

- GitHub Search API: 30 requests/minute (authenticated). The parallel searches in Phase 2 typically use 5-8 requests. Phase 4 deep dives use 1 request per candidate.
- If rate limited (HTTP 403/429), reduce parallelism and add brief pauses.
- Use `per_page=30` for broad label/scope searches; `per_page=100` only for narrow targeted queries.

## Tips

- The conventional commit scope (e.g., `telegram` from `fix(telegram): ...`) is your strongest clustering signal at OpenClaw scale — always extract and search on it.
- PRs in the same `src/{channel}/` directory are almost certainly related even if titles look different.
- Stale PRs (>90 days) that overlap with a fresh PR are almost always superseded — mark them as close candidates.
- Always follow issue references — `fixes #NNNN` in the body leads to the most reliable duplicate discovery since multiple PRs often target the same issue.
- Size labels help triage quickly: `size: XS`/`size: S` PRs are usually focused fixes, `size: L`/`size: XL` are broader refactors.
- If the cluster is very large (>15 Tier 1+2), further sub-cluster by exact file overlap to identify truly identical attempts vs related-but-different fixes.

## Closing Message Templates

After the cluster analysis, use the appropriate template when closing superseded PRs. Adapt the details to the specific situation — these are structures, not rigid scripts. Always use single-quoted heredoc (`-F - <<'EOF'`) for `gh` comments to avoid shell escaping issues.

### Template 1: Already Fixed on Main

Use when the problem was already resolved by a landed commit.

```
Closing — this was already fixed on `main`.

**What landed:**

- {commit_sha_short} ([`{title}`](https://github.com/{owner}/{repo}/commit/{sha})) shipped on {date}, which {brief description of what the fix did}.

**Why this PR is no longer needed:**

- {Specific explanation of why the landed fix makes this PR unnecessary.}
- {Any other context — e.g., the fix took a different approach, the behavior this PR changes is now correct, etc.}

Thank you for flagging this, @{author}! {Optional: acknowledge that the problem they identified was real, even if the fix path differed.}
```

### Template 2: Duplicate of Another Open PR

Use when closing in favor of a canonical PR that will be reviewed/merged.

```
Closing this as a duplicate to keep the discussion and CI signal in one place.

**Why this is duplicate:**

- This PR and #{canonical} both modify the same core path (`{shared_file}`) to {what they both do}.
- Both target the same user-visible symptom: {description of the shared problem}.
- Keeping both open fragments review/CI and increases merge-conflict risk for the same logic area.

**Canonical thread to continue on:**

- #{canonical} — {brief reason why that one was chosen: more complete, has tests, fresher rebase, etc.}

If there is any behavior in this PR that is not covered by #{canonical}, please call it out there and we can fold it in explicitly.

Thank you for the contribution, @{author}!
```

### Template 3: Superseded by a Different Approach

Use when a maintainer chose a fundamentally different solution path.

```
Closing — this was addressed via a different approach.

**What shipped instead:**

- #{landed_pr} / {commit_sha} took the approach of {description}, rather than {what this PR did}.
- {Why the alternative approach was preferred, e.g., "backward compatibility", "broader fix", "addresses root cause"}.

**Related threads:**

- #{canonical_pr} for the implementation that landed.
- #{issue} for the original issue, now resolved.

Thank you for the PR, @{author} — the problem you identified was valid and helped inform the fix that shipped.
```

### Template 4: Stale / Abandoned with Active Replacement

Use when a PR went stale and a newer attempt exists.

```
Closing — this went stale and a more recent PR addresses the same problem.

**Active replacement:**

- #{newer_pr} ({title}) covers the same fix with {what makes it better: tests, changelog, fresher rebase}.

If you'd like to continue contributing to this area, #{newer_pr} is the thread to follow.

Thank you for the early work on this, @{author}!
```

### Usage Notes

- Always thank the contributor by @-mentioning them.
- Always link to the canonical PR/commit/issue so the contributor can follow up.
- Never use backticks around issue/PR refs like `#12345` — use plain #12345 so GitHub auto-links them.
- Post the comment via: `gh pr comment {number} -R {owner}/{repo} -F - <<'EOF'\n{message}\nEOF`

### Confirmation Gate

**Never close PRs without explicit maintainer approval.** The workflow is:

1. Draft all closing comments and present them to the maintainer for review.
2. Show the full list: which PRs will be closed, which template is used, and the exact comment text.
3. Wait for explicit "go" / approval before posting any comments or closing any PRs.
4. Close PRs one at a time with comment + close:

```bash
# Comment first, then close
gh pr comment {number} -R {owner}/{repo} -F - <<'EOF'
{closing message}
EOF

gh pr close {number} -R {owner}/{repo}
```

5. After all closures, report what was done with links to each closed PR's comment.

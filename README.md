# New Maintainer Guide

A focused survival guide for your first week as an OpenClaw maintainer. This covers the essentials — setup, security, first PRs, processes, and where to find help. For deeper reference, check the full knowledge base or ask in `#maintainers`.

---

## Setup

```bash
# Clone and build
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build            # Build (instant with tsdown)
pnpm check            # Combined lint + format + types
pnpm test             # Full test suite (~87s)

# Install maintainer skills (PR workflow tools)
npx skills add https://github.com/openclaw/maintainers

# Install OpenClaw itself
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw doctor       # Run diagnostics
```

---

## Security Hardening

You are now a target for phishing, social engineering, and supply chain attacks. Harden your accounts immediately.

- [ ] Enable 2FA on GitHub using an authenticator app
- [ ] Remove SMS as a 2FA backup (SIM swap risk)
- [ ] Set up GPG-signed git commits
- [ ] Get a YubiKey/FIDO2 hardware key (strongly recommended)
- [ ] Use a password manager (1Password/Bitwarden) for all passwords
- [ ] Rotate all API keys and tokens
- [ ] Block random Discord/LinkedIn/Instagram friend requests
- [ ] Never click unverified cal.com scheduling links
- [ ] Don't run OpenClaw with a personal identity that has access to sensitive systems
- [ ] Verify identity through a separate channel before any sensitive action

---

## First Week

### Day 1-2: Orient and Observe

- [ ] Follow threads in `#maintainers` (the main discussion channel)
- [ ] Read pinned messages in `#maintainers`
- [ ] Read the PR workflow: [`.agents/skills/PR_WORKFLOW.md`](.agents/skills/PR_WORKFLOW.md)
- [ ] Browse small PRs: filter by `is:open is:pr label:size:xs`
- [ ] Pick one and read it thoroughly — don't take action yet
- [ ] Run `/reviewpr` on it to see the AI review output
- [ ] Read 3-5 recently merged PRs to learn the pattern

### Day 3-5: Your First PR

- [ ] Assign yourself to a `size:xs` PR ("if you lick it, it's yours")
- [ ] Review with AI: `/reviewpr` in Codex
- [ ] Evaluate: What's the actual problem? Is this the most optimal fix?
- [ ] Rework if needed — rewriting contributor code is normal and expected
- [ ] Run gates: `pnpm lint && pnpm build && pnpm test`
- [ ] Update CHANGELOG.md with the PR number and thank the contributor
- [ ] Merge using `/landpr` or `/mergepr`

> **Important:** Treat PRs as problem descriptions, not finished code. Fixing up code before merging is standard practice.

### Week 2+: Build Your Rhythm

- [ ] Review and land 2-3 more `size:xs` PRs
- [ ] Run the gateway locally: `pnpm gateway:watch` (requires `pnpm build` first)
- [ ] Explore key source files: `src/gateway/`, `src/auto-reply/envelope.ts`, `src/config/`, `src/agents/`
- [ ] Start looking at `size:s` PRs
- [ ] Begin closing obvious junk PRs politely ("Thank you for your kind PR")

---

## PR Filters

| Filter | Use |
|---|---|
| `is:open is:pr label:size:xs` | Smallest, safest PRs to start with |
| `is:open is:pr label:trusted-contributor` | Higher-quality submissions |
| `is:open is:pr label:maintainer` | Other maintainer PRs (review these) |

### The 3-Step Workflow

Review → Prepare → Merge. See [`PR_WORKFLOW.md`](.agents/skills/PR_WORKFLOW.md) for the full process.

1. **Review:** Run `/reviewpr`. Evaluate the problem, implementation, security impact.
2. **Prepare:** Rebase, fix code, run all gates, push changes.
3. **Merge:** Squash-merge, update CHANGELOG, close the PR.

### Auto-Close These

- **Skills PRs** — redirect to [ClawHub](https://clawhub.ai) (use `clawdhub` label)
- **PRs > 5K LOC** — auto-closed per policy
- **`@ts-nocheck` or lint disabling** — never acceptable
- **Rename/rebrand spam** — close politely

---

## Volume and Triage

PR and issue volume is high. Triage bots handle first-pass filtering so you can focus on promising PRs. Releases happen roughly daily. The flow: cut beta → maintainers test → fix regressions → ship stable.

---

## Do's and Don'ts

### Do

- Run `pnpm lint && pnpm build && pnpm test` before every merge
- Always rebase before merging (stale PRs break main)
- Thank real humans in CHANGELOG entries
- Announce in `#maintainers` before breaking changes
- Show, don't tell — demos get quick approvals
- Ask "does this exist somewhere already?" before building

### Don't

- Push untested code to main
- Merge your own non-trivial PRs without review
- Use bun (incompatible with upstream deps)
- Update Carbon dependency (Shadow controls it)
- Send AI-generated text to external maintainers' repos
- Share anything from `#maintainers` externally
- Use LLMs to write GitHub comments pretending to be human
- Put date/time in system prompts per-message (breaks token cache, 10x cost)
- Add `@ts-nocheck` or disable lint rules

---

## Who to Ask

For team contacts, area ownership, and subsystem maintainers, see the [maintainer table in CONTRIBUTING.md](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md#maintainers). For Discord handles and internal communication norms, check the pinned messages in `#maintainers`.

---

## Key Files

| File | Why It Matters |
|---|---|
| `CONTRIBUTING.md` | Maintainer list, subsystem ownership, PR process |
| `VISION.md` | Priorities and what NOT to merge |
| `AGENTS.md` | AI agent behavior guidelines |
| `SECURITY.md` | Vulnerability reporting |
| `CHANGELOG.md` | Updated with every merge |
| `.agents/skills/PR_WORKFLOW.md` | The 3-step PR pipeline |

---

## Quick Commands

```bash
pnpm build             # Build
pnpm check             # Lint + format + types (fast)
pnpm test              # Full test suite (~87s)
pnpm tsgo              # Type check only (10x faster)
pnpm gateway:watch     # Run gateway locally (build first!)
pnpm format            # Format code
openclaw update        # Update OpenClaw
openclaw doctor --fix  # Diagnose and fix issues
```

---

## Resources

| Resource | URL |
|---|---|
| Main repo | https://github.com/openclaw/openclaw |
| Docs | https://docs.openclaw.ai |
| ClawHub (skills marketplace) | https://clawhub.ai |
| Security/trust | https://trust.openclaw.ai |
| Maintainer skills repo | https://github.com/openclaw/maintainers |
| Discord | discord.gg/openclaw |
| Install script | `curl -fsSL https://openclaw.ai/install.sh \| bash` |
| Beta install | `curl -fsSL https://openclaw.ai/install.sh \| bash -s -- --beta` |
| Security reports | security@openclaw.ai |
| Contributing/apply | contributing@openclaw.ai |

---

## Beyond Week 1

- Build a daily rhythm — 1-hour PR review block, graduate to larger PRs
- Pick a subsystem — review the ownership table in [CONTRIBUTING.md](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md#maintainers), announce your focus in `#maintainers`
- Watch a release — observe the beta → stable flow in `#maintainers`
- Make an original contribution — pick a bug from post-release issues, submit a proper PR

The project runs on trust. Voluntary, fun-first, informal. Ship fast, iterate, and "code > talk."

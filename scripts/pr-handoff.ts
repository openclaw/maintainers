#!/usr/bin/env -S node --import tsx

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_OUTPUT_DIR } from "../pr-ops/core/constants.ts";
import { resolveMaintainersPath } from "../pr-ops/core/paths.ts";
import type { PlanItem } from "../pr-ops/core/types.ts";
import {
  DEFAULT_STATE_PATH,
  buildResolvedPrSet,
  findPlanItemByPrNumber,
  isPlanItemResolved,
  parseRepoFromPrUrl,
  readDailyPlan,
  readDecisionLog,
} from "../pr-ops/state/decisions.ts";
import {
  DEFAULT_CLAIMS_PATH,
  buildActiveClaimsByPrNumber,
  readClaimLog,
  resolveClaimOwner,
} from "../pr-ops/state/claims.ts";

type HandoffTool = "codex" | "claude";

type CliOptions = {
  outputDir: string;
  statePath: string;
  claimsPath: string;
  tool: HandoffTool;
  ownerInput: string | null;
  prNumber: number | null;
  verbose: boolean;
  json: boolean;
};

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node --import tsx scripts/pr-handoff.ts [options]",
      "",
      "Options:",
      `  --out <dir>             Plan output directory (default: ${DEFAULT_OUTPUT_DIR})`,
      `  --state <path>          Decision log path (default: ${DEFAULT_STATE_PATH})`,
      `  --claims <path>         Claim log path (default: ${DEFAULT_CLAIMS_PATH})`,
      "  --tool <name>           Target assistant style: codex|claude (default: codex)",
      "  --owner <name>          Owner id (optional; falls back to PR_OPS_OWNER or USER)",
      "  --pr <number>           Specific PR number from queue (default: next unresolved)",
      "  --verbose               Include handoff metadata and operator command hints",
      "  --json                  Print JSON payload",
      "  --help                  Show this help",
    ].join("\n"),
  );
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parseTool(value: string): HandoffTool {
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new Error(`Invalid --tool value: ${value}. Expected 'codex' or 'claude'.`);
}

function parseArgs(argv: string[]): CliOptions {
  let outputDir = DEFAULT_OUTPUT_DIR;
  let statePath = DEFAULT_STATE_PATH;
  let claimsPath = DEFAULT_CLAIMS_PATH;
  let tool: HandoffTool = "codex";
  let ownerInput: string | null = null;
  let prNumber: number | null = null;
  let verbose = false;
  let json = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--out") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --out value");
      }
      outputDir = next;
      index++;
      continue;
    }
    if (arg === "--state") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --state value");
      }
      statePath = next;
      index++;
      continue;
    }
    if (arg === "--claims") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --claims value");
      }
      claimsPath = next;
      index++;
      continue;
    }
    if (arg === "--tool") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --tool value");
      }
      tool = parseTool(next);
      index++;
      continue;
    }
    if (arg === "--owner") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --owner value");
      }
      ownerInput = next.trim();
      index++;
      continue;
    }
    if (arg === "--pr") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --pr value");
      }
      prNumber = parsePositiveInt(next, "--pr");
      index++;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { outputDir, statePath, claimsPath, tool, ownerInput, prNumber, verbose, json };
}

function pickNextAvailableItem(input: {
  selected: PlanItem[];
  resolved: Set<number>;
  activeClaimsByPr: Map<number, { owner: string; expiresAt: string | null }>;
  owner: string | null;
}) {
  const { selected, resolved, activeClaimsByPr, owner } = input;
  for (const item of selected) {
    if (isPlanItemResolved(item, resolved)) {
      continue;
    }
    const claim = activeClaimsByPr.get(item.representativeNumber);
    if (!claim || (owner && claim.owner === owner)) {
      return { item, claim: claim ?? null };
    }
  }
  return { item: null, claim: null };
}

function buildPrompt(input: {
  tool: HandoffTool;
  repo: string | null;
  url: string;
  title: string;
  lane: string;
  representativeNumber: number;
  originNumber: number | null;
  clusterMembers: number[];
  pendingMembers: number[];
  policyFlags: string[];
  rationale: string[];
}) {
  const repoLine = input.repo ? `Repository: ${input.repo}` : "Repository: openclaw/openclaw";
  const originLine =
    input.originNumber === null
      ? "Origin PR: n/a (single PR item)"
      : `Origin PR: #${input.originNumber}`;
  const clusterLine =
    input.clusterMembers.length > 1
      ? `Cluster members: ${input.clusterMembers.join(", ")}`
      : "Cluster members: n/a";
  const pendingLine =
    input.pendingMembers.length > 0
      ? `Pending members: ${input.pendingMembers.join(", ")}`
      : "Pending members: none";
  const policyLine =
    input.policyFlags.length > 0
      ? `Policy flags: ${input.policyFlags.join(", ")}`
      : "Policy flags: none";
  const promptHeader = "Review this PR and take a final maintainer action.";
  const pendingMembersLine =
    input.pendingMembers.length > 0 ? input.pendingMembers.join(", ") : "none";
  const originNumber = input.originNumber ?? input.representativeNumber;
  const closeDuplicateMembers = input.pendingMembers
    .filter((number) => number !== input.representativeNumber)
    .join(", ");

  return [
    promptHeader,
    "",
    "Operating constraints:",
    "- You are working in the openclaw repo reviewer flow.",
    "- Use the configured review skills for proper review and any final actions.",
    "- Do not run pr-ops state commands (`scripts/pr-decide`) from reviewer context.",
    "",
    `${repoLine}`,
    `PR: ${input.url}`,
    `PR Number: #${input.representativeNumber}`,
    `Title: ${input.title}`,
    `Queue lane: ${input.lane}`,
    originLine,
    clusterLine,
    pendingLine,
    policyLine,
    `Queue rationale: ${input.rationale.join(" | ")}`,
    "",
    "Workflow order (strict, tool-agnostic):",
    "1) Complete these phases on the representative PR, in order: review -> prepare -> merge.",
    "2) Use your configured workflow/skills for each phase (OpenClaw default: review-pr -> prepare-pr -> merge-pr, default merge mode: squash).",
    "3) Do not skip, reorder, or partially execute phases.",
    "4) If a required command in the current phase fails, retry the SAME command up to 3 times with escalation when needed.",
    "5) If still failing after retries, stop and return `defer` with the concrete blocker.",
    "6) Do not use manual git/gh fallback to bypass required commands in your configured workflow.",

    "Action policy (use your configured skills for all final actions):",
    "1) If PR is acceptable: complete the strict phased workflow above on the representative PR.",
    "2) If PR is duplicate: close duplicate member PRs with a proper comment referencing origin PR.",
    "3) If PR is not planned: close representative PR as not planned.",
    "4) If uncertain: defer and explain the blocker.",
    "",
    "Cluster-specific guidance:",
    `- Origin PR: #${originNumber}`,
    `- Pending members: ${pendingMembersLine}`,
    `- If merged origin PR, close duplicate pending members (exclude representative): ${closeDuplicateMembers || "none"}`,
    `- Duplicate closure note should reference: duplicate of #${originNumber}`,
    "",
    "Return this exact structured block after finishing actions:",
    "outcome: merge | close_duplicate | close_not_planned | defer",
    `primary_pr: ${input.representativeNumber}`,
    "affected_prs: [comma-separated PR numbers you merged/closed]",
    "short_note: one-line reason",
    "actions_taken: merged representative | closed duplicates | closed not planned | no-action",
  ].join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const owner = resolveClaimOwner(options.ownerInput);
  const outputDir = resolveMaintainersPath(options.outputDir);
  const statePath = resolveMaintainersPath(options.statePath);
  const claimsPath = resolveMaintainersPath(options.claimsPath);
  const plan = readDailyPlan(resolve(outputDir, "daily-plan.json"));
  const records = readDecisionLog(statePath);
  const resolved = buildResolvedPrSet(records);
  const activeClaimsByPr = buildActiveClaimsByPrNumber(readClaimLog(claimsPath));

  const selected =
    options.prNumber === null
      ? pickNextAvailableItem({
          selected: plan.selected,
          resolved,
          activeClaimsByPr,
          owner,
        })
      : (() => {
          const item = findPlanItemByPrNumber(plan, options.prNumber);
          const claim = item ? (activeClaimsByPr.get(item.representativeNumber) ?? null) : null;
          return { item, claim };
        })();
  const item = selected.item;
  const claim = selected.claim;

  if (!item) {
    throw new Error(
      "No queue item found. Run scripts/pr-plan first, or set PR_OPS_OWNER / use --owner for claimed items.",
    );
  }

  if (claim && claim.owner !== owner) {
    throw new Error(
      `PR #${item.representativeNumber} is claimed by '${claim.owner}'. Set PR_OPS_OWNER=${claim.owner}, pass --owner ${claim.owner}, or choose another PR.`,
    );
  }

  const pendingMembers = item.clusterMembers.filter((number) => !resolved.has(number));
  const prompt = buildPrompt({
    tool: options.tool,
    repo: parseRepoFromPrUrl(item.representativeUrl),
    url: item.representativeUrl,
    title: item.title,
    lane: item.lane,
    representativeNumber: item.representativeNumber,
    originNumber: item.originNumber,
    clusterMembers: item.clusterMembers,
    pendingMembers,
    policyFlags: item.policyFlags,
    rationale: item.rationale,
  });

  const originNumber = item.originNumber ?? item.representativeNumber;
  const mergeRecordCommand = `scripts/pr-decide --decision merge --pr ${originNumber} --note "merged"`;
  const mergeAndCloseDuplicatesCommand = `scripts/pr-decide --decision merge --pr ${originNumber} --auto-close-duplicates --note "merged"`;
  const closeDuplicateCommand = `scripts/pr-decide --decision close_duplicate --pr ${originNumber} --note "duplicate of #${originNumber}"`;
  const closeNotPlannedCommand = `scripts/pr-decide --decision close_not_planned --pr ${item.representativeNumber} --note "closed: not planned"`;
  const mergeAlternateWinnerTemplate =
    'scripts/pr-decide --decision merge --pr <merged_cluster_member_pr> --auto-close-duplicates --note "merged"';

  const payload = {
    tool: options.tool,
    owner,
    representativeNumber: item.representativeNumber,
    originNumber: item.originNumber,
    lane: item.lane,
    url: item.representativeUrl,
    claimOwner: claim?.owner ?? null,
    claimExpiresAt: claim?.expiresAt ?? null,
    pendingMembers,
    prompt,
    recordCommands: {
      merge: mergeRecordCommand,
      merge_with_auto_close_duplicates: mergeAndCloseDuplicatesCommand,
      merge_alternate_cluster_winner_template: mergeAlternateWinnerTemplate,
      close_duplicate_cluster: closeDuplicateCommand,
      close_not_planned: closeNotPlannedCommand,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!options.verbose) {
    // Default mode: print only the exact reviewer handoff prompt for copy/paste.
    console.log(prompt);
    return;
  }

  console.log(`Handoff target: #${item.representativeNumber} (${item.lane})`);
  console.log(`URL: ${item.representativeUrl}`);
  if (claim?.owner) {
    console.log(`Claim: owner=${claim.owner} expires=${claim.expiresAt ?? "n/a"}`);
  }
  console.log("");
  console.log("Paste this into your reviewer agent:");
  console.log("");
  console.log(prompt);
  console.log("");
  console.log("Operator commands (run in pr-ops context after reviewer action):");
  if (item.clusterMembers.length > 1) {
    console.log(
      `- Merge origin + auto close duplicates (one command): ${mergeAndCloseDuplicatesCommand}`,
    );
    console.log(`- If you merged a different cluster member, use: ${mergeAlternateWinnerTemplate}`);
  }
  console.log(`- Merge origin: ${mergeRecordCommand}`);
  if (item.clusterMembers.length > 1) {
    console.log(`- Close duplicate members: ${closeDuplicateCommand}`);
  }
  console.log(`- Close not planned: ${closeNotPlannedCommand}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

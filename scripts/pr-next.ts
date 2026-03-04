#!/usr/bin/env -S node --import tsx

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { DEFAULT_OUTPUT_DIR } from "../pr-ops/core/constants.ts";
import { resolveMaintainersPath } from "../pr-ops/core/paths.ts";
import type { PlanItem } from "../pr-ops/core/types.ts";
import { fetchPullRequestLiveStatus } from "../pr-ops/github/client.ts";
import {
  DECISION_OUTCOMES,
  DEFAULT_STATE_PATH,
  buildResolvedPrSet,
  isPlanItemResolved,
  parseRepoFromPrUrl,
  readDailyPlan,
  readDecisionLog,
} from "../pr-ops/state/decisions.ts";
import {
  DEFAULT_CLAIMS_PATH,
  DEFAULT_CLAIM_TTL_MINUTES,
  appendClaimRecord,
  buildActiveClaimsByPrNumber,
  computeClaimExpiry,
  readClaimLog,
  resolveClaimOwner,
} from "../pr-ops/state/claims.ts";

type CliOptions = {
  outputDir: string;
  statePath: string;
  claimsPath: string;
  ownerInput: string | null;
  ttlMinutes: number;
  liveStatus: boolean;
  json: boolean;
};

type ClosedStatusCacheEntry = {
  checkedAt: string;
  state: "closed";
  merged: boolean;
  mergedAt: string | null;
};

const CLOSED_STATUS_CACHE_FILE = "pr-live-status-cache.json";
const CLOSED_STATUS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node --import tsx scripts/pr-next.ts [options]",
      "",
      "Options:",
      `  --out <dir>             Plan output directory (default: ${DEFAULT_OUTPUT_DIR})`,
      `  --state <path>          Decision log path (default: ${DEFAULT_STATE_PATH})`,
      `  --claims <path>         Claim log path (default: ${DEFAULT_CLAIMS_PATH})`,
      "  --owner <name>          Owner id (optional; falls back to PR_OPS_OWNER or USER)",
      `  --ttl-minutes <n>       Auto-claim lease duration in minutes (default: ${DEFAULT_CLAIM_TTL_MINUTES})`,
      "  --no-live-status        Skip GitHub live status check (default: enabled)",
      "  --json                  Print JSON payload for automation",
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

function parseArgs(argv: string[]): CliOptions {
  let outputDir = DEFAULT_OUTPUT_DIR;
  let statePath = DEFAULT_STATE_PATH;
  let claimsPath = DEFAULT_CLAIMS_PATH;
  let ownerInput: string | null = null;
  let ttlMinutes = DEFAULT_CLAIM_TTL_MINUTES;
  let liveStatus = true;
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
    if (arg === "--owner") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --owner value");
      }
      ownerInput = next.trim();
      index++;
      continue;
    }
    if (arg === "--ttl-minutes") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --ttl-minutes value");
      }
      ttlMinutes = parsePositiveInt(next, "--ttl-minutes");
      index++;
      continue;
    }
    if (arg === "--no-live-status") {
      liveStatus = false;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { outputDir, statePath, claimsPath, ownerInput, ttlMinutes, liveStatus, json };
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

function readClosedStatusCache(path: string): Record<string, ClosedStatusCacheEntry> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") {
      return {};
    }
    const cache: Record<string, ClosedStatusCacheEntry> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const checkedAt = (value as { checkedAt?: unknown }).checkedAt;
      const state = (value as { state?: unknown }).state;
      const merged = (value as { merged?: unknown }).merged;
      const mergedAt = (value as { mergedAt?: unknown }).mergedAt;
      if (typeof checkedAt !== "string" || state !== "closed") {
        continue;
      }
      cache[key] = {
        checkedAt,
        state: "closed",
        merged: Boolean(merged),
        mergedAt: typeof mergedAt === "string" && mergedAt.length > 0 ? mergedAt : null,
      };
    }
    return cache;
  } catch {
    return {};
  }
}

function writeClosedStatusCache(path: string, cache: Record<string, ClosedStatusCacheEntry>) {
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function isClosedCacheFresh(entry: ClosedStatusCacheEntry, nowMs: number): boolean {
  const checkedMs = Date.parse(entry.checkedAt);
  return Number.isFinite(checkedMs) && nowMs - checkedMs <= CLOSED_STATUS_CACHE_TTL_MS;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const owner = resolveClaimOwner(options.ownerInput);
  const outputDir = resolveMaintainersPath(options.outputDir);
  const statePath = resolveMaintainersPath(options.statePath);
  const claimsPath = resolveMaintainersPath(options.claimsPath);
  const planPath = resolve(outputDir, "daily-plan.json");
  const plan = readDailyPlan(planPath);
  const records = readDecisionLog(statePath);
  const resolved = buildResolvedPrSet(records);
  const activeClaimsByPr = buildActiveClaimsByPrNumber(readClaimLog(claimsPath));
  const transientResolved = new Set(resolved);
  const liveSkipped: Array<{ prNumber: number; reason: string }> = [];
  const liveCachePath = resolve(outputDir, CLOSED_STATUS_CACHE_FILE);
  const closedStatusCache = readClosedStatusCache(liveCachePath);
  let cacheDirty = false;

  let next: PlanItem | null = null;
  let selectedClaim: { owner: string; expiresAt: string | null } | null = null;

  while (true) {
    const selected = pickNextAvailableItem({
      selected: plan.selected,
      resolved: transientResolved,
      activeClaimsByPr,
      owner,
    });
    if (!selected.item) {
      break;
    }

    const candidate = selected.item;
    const repo = parseRepoFromPrUrl(candidate.representativeUrl);
    if (!repo || !options.liveStatus) {
      next = candidate;
      selectedClaim = selected.claim;
      break;
    }

    const cacheKey = String(candidate.representativeNumber);
    const nowMs = Date.now();
    const cached = closedStatusCache[cacheKey];
    if (cached && isClosedCacheFresh(cached, nowMs)) {
      liveSkipped.push({
        prNumber: candidate.representativeNumber,
        reason: cached.merged ? "merged (cached)" : "closed (cached)",
      });
      for (const member of candidate.clusterMembers) {
        transientResolved.add(member);
      }
      continue;
    }

    const liveStatus = fetchPullRequestLiveStatus(repo, candidate.representativeNumber);
    if (!liveStatus) {
      next = candidate;
      selectedClaim = selected.claim;
      break;
    }

    if (liveStatus.state === "open") {
      if (cacheKey in closedStatusCache) {
        delete closedStatusCache[cacheKey];
        cacheDirty = true;
      }
      next = candidate;
      selectedClaim = selected.claim;
      break;
    }

    closedStatusCache[cacheKey] = {
      checkedAt: new Date().toISOString(),
      state: "closed",
      merged: liveStatus.merged,
      mergedAt: liveStatus.mergedAt,
    };
    cacheDirty = true;
    liveSkipped.push({
      prNumber: candidate.representativeNumber,
      reason: liveStatus.merged ? "merged" : "closed",
    });
    // Skip stale queue items for this run to avoid looping on closed representatives.
    for (const member of candidate.clusterMembers) {
      transientResolved.add(member);
    }
  }

  if (cacheDirty) {
    writeClosedStatusCache(liveCachePath, closedStatusCache);
  }

  if (!next) {
    const blockedByClaims = plan.selected.some((item) => {
      if (isPlanItemResolved(item, resolved)) {
        return false;
      }
      const active = activeClaimsByPr.get(item.representativeNumber);
      return Boolean(active && (!owner || active.owner !== owner));
    });
    const payload = {
      done: true,
      reason: blockedByClaims ? "all_unresolved_items_claimed" : "queue_complete",
      message: blockedByClaims
        ? "No unclaimed queue items available for this owner."
        : "Queue complete: all planned items are resolved in state log.",
      liveSkipped,
    };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(payload.message);
    return;
  }

  let claim = selectedClaim;
  let claimStatus: "none" | "existing" | "new" = claim ? "existing" : "none";
  if (!claim && owner) {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = computeClaimExpiry(now, options.ttlMinutes);
    appendClaimRecord(claimsPath, {
      id: `${Date.now()}-${next.representativeNumber}-${Math.random().toString(16).slice(2, 8)}`,
      claimedAt: nowIso,
      owner,
      prNumber: next.representativeNumber,
      action: "claim",
      expiresAt,
      note: "auto-claim from pr-next",
    });
    claim = {
      id: "active",
      claimedAt: nowIso,
      owner,
      prNumber: next.representativeNumber,
      expiresAt,
      note: "auto-claim from pr-next",
    };
    claimStatus = "new";
  }

  const pendingMembers = next.clusterMembers.filter((number) => !resolved.has(number));
  const repo = parseRepoFromPrUrl(next.representativeUrl);
  const checkoutHint = repo
    ? `gh pr checkout ${next.representativeNumber} --repo ${repo}`
    : `gh pr checkout ${next.representativeNumber}`;
  const payload = {
    done: false,
    lane: next.lane,
    representativeNumber: next.representativeNumber,
    originNumber: next.originNumber,
    decisionGain: next.decisionGain,
    clusterId: next.clusterId,
    pendingMembers,
    url: next.representativeUrl,
    title: next.title,
    checkoutHint,
    claimOwner: claim?.owner ?? null,
    claimExpiresAt: claim?.expiresAt ?? null,
    claimStatus,
    owner,
    liveSkipped,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Next: ${next.lane} #${next.representativeNumber} (gain=${next.decisionGain})`);
  if (next.originNumber !== null) {
    console.log(`Origin: #${next.originNumber}`);
  }
  console.log(`Title: ${next.title}`);
  console.log(`URL: ${next.representativeUrl}`);
  console.log(`Pending members: ${pendingMembers.join(", ")}`);
  if (claim?.owner) {
    console.log(`Claim: owner=${claim.owner} expires=${claim.expiresAt ?? "n/a"} (${claimStatus})`);
  }
  if (liveSkipped.length > 0) {
    const skippedSummary = liveSkipped
      .map((entry) => `#${entry.prNumber} ${entry.reason}`)
      .join(", ");
    console.log(`Live-skip: ${skippedSummary}`);
  }
  console.log(`Checkout: ${checkoutHint}`);
  console.log(
    `Decide: scripts/pr-decide --out ${options.outputDir} --state ${options.statePath} --decision <${DECISION_OUTCOMES.join("|")}> --pr ${next.representativeNumber}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

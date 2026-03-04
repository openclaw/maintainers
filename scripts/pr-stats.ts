#!/usr/bin/env -S node --import tsx

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_OUTPUT_DIR } from "../pr-ops/core/constants.ts";
import { resolveMaintainersPath } from "../pr-ops/core/paths.ts";
import {
  DEFAULT_CLAIMS_PATH,
  buildActiveClaimsByPrNumber,
  readClaimLog,
  summarizeActiveClaimsByOwner,
} from "../pr-ops/state/claims.ts";
import {
  DEFAULT_STATE_PATH,
  computeDecisionStats,
  readDailyPlan,
  readDecisionLog,
} from "../pr-ops/state/decisions.ts";

type CliOptions = {
  outputDir: string;
  statePath: string;
  claimsPath: string;
  json: boolean;
};

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node --import tsx scripts/pr-stats.ts [options]",
      "",
      "Options:",
      `  --out <dir>             Plan output directory (default: ${DEFAULT_OUTPUT_DIR})`,
      `  --state <path>          Decision log path (default: ${DEFAULT_STATE_PATH})`,
      `  --claims <path>         Claim log path (default: ${DEFAULT_CLAIMS_PATH})`,
      "  --json                  Print JSON payload for automation",
      "  --help                  Show this help",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliOptions {
  let outputDir = DEFAULT_OUTPUT_DIR;
  let statePath = DEFAULT_STATE_PATH;
  let claimsPath = DEFAULT_CLAIMS_PATH;
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
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { outputDir, statePath, claimsPath, json };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = resolveMaintainersPath(options.outputDir);
  const statePath = resolveMaintainersPath(options.statePath);
  const claimsPath = resolveMaintainersPath(options.claimsPath);
  const planPath = resolve(outputDir, "daily-plan.json");
  const plan = readDailyPlan(planPath);
  const records = readDecisionLog(statePath);
  const stats = computeDecisionStats(plan, records);
  const activeClaimsByPr = buildActiveClaimsByPrNumber(readClaimLog(claimsPath));
  const activeClaimsByOwner = summarizeActiveClaimsByOwner(activeClaimsByPr);
  const statsPayload = {
    ...stats,
    activeClaims: activeClaimsByPr.size,
    activeClaimsByOwner,
  };

  if (options.json) {
    console.log(JSON.stringify(statsPayload, null, 2));
    return;
  }

  console.log(`Mode: ${stats.mode}`);
  console.log(`Target decisions: ${stats.targetDecisions}`);
  console.log(`Planned: ${stats.plannedDecisions} decisions from ${stats.plannedReviews} reviews`);
  console.log(`Logged decisions: ${stats.totalDecisions}`);
  console.log(`Logged active reviews: ${stats.activeReviews}`);
  console.log(`Decision gain ratio: ${stats.decisionGainRatio.toFixed(2)}`);
  console.log(`Dedupe savings: ${stats.dedupeSavings}`);
  console.log(
    `Resolved queue items: ${stats.resolvedQueueItems}/${stats.queueSize} (remaining ${stats.remainingQueueItems})`,
  );
  console.log(
    `Resolved mix: cluster=${stats.resolvedClusterDecisions}, single=${stats.resolvedSingleDecisions}`,
  );
  console.log(`Remaining decisions to target: ${stats.remainingDecisionsToTarget}`);
  console.log(`Active claims: ${activeClaimsByPr.size}`);
  if (activeClaimsByOwner.length > 0) {
    console.log(
      `Claim owners: ${activeClaimsByOwner.map((row) => `${row.owner}=${row.count}`).join(", ")}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

#!/usr/bin/env -S node --import tsx

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { analyzePullRequests } from "../pr-ops/core/analysis.ts";
import {
  buildClusters,
  computeClusterRefinements,
  normalizeTitleForClustering,
} from "../pr-ops/core/clustering.ts";
import {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_REPO,
  DEFAULT_TARGET_DECISIONS,
} from "../pr-ops/core/constants.ts";
import { resolveMaintainersPath } from "../pr-ops/core/paths.ts";
import {
  computeOpenPullRequestWatermark,
  fetchOpenPullRequests,
  refreshOpenPullRequestsFromCache,
  readCachedOpenPullRequests,
  writeJson,
  writeJsonLines,
} from "../pr-ops/github/client.ts";
import { applyPolicyFlagsToPlan, buildDailyPlan } from "../pr-ops/core/planning.ts";
import { detectPolicyFlags } from "../pr-ops/core/policy.ts";
import { toMarkdown, toTsv } from "../pr-ops/cli/render.ts";
import type { ParsedCliOptions, PlanMode } from "../pr-ops/core/types.ts";

export type { OpenPullRequest } from "../pr-ops/core/types.ts";
export { buildClusters, buildDailyPlan, detectPolicyFlags, normalizeTitleForClustering };

const OPEN_PR_CACHE_META_FILE = "open-prs-meta.json";
const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

type OpenPrCacheMeta = {
  repo: string;
  lastSyncAt: string;
  lastFullSyncAt: string;
  lastMode: "full" | "incremental";
  totalOpen: number;
  watermark: string | null;
};

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainderSeconds}s`;
}

function createProgressLogger() {
  const runStartedAt = Date.now();
  const log = (message: string) => {
    const timestamp = new Date().toISOString().slice(11, 19);
    console.log(`[pr-plan ${timestamp}] ${message}`);
  };
  const runStage = <T>(name: string, work: () => T): T => {
    const stageStartedAt = Date.now();
    log(`${name}...`);
    const result = work();
    log(`${name} done (${formatDurationMs(Date.now() - stageStartedAt)})`);
    return result;
  };

  return {
    log,
    runStage,
    summary: () => formatDurationMs(Date.now() - runStartedAt),
  };
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node --import tsx scripts/pr-plan.ts [options]",
      "",
      "Options:",
      `  --repo <owner/name>     Target repository (default: ${DEFAULT_REPO})`,
      `  --target <count>        Daily decision target (default: ${DEFAULT_TARGET_DECISIONS})`,
      "  --mode <name>           Plan mode: dedupe-first|balanced (default: dedupe-first)",
      `  --out <dir>             Output directory (default: ${DEFAULT_OUTPUT_DIR})`,
      "  --use-cache             Use cached open-pr list only (fails if cache is missing)",
      "  --live                  Refresh open-pr list from GitHub (incremental when cache exists)",
      "                          Default without flags: cache-first (use cache if present, else fetch once)",
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

function parseMode(value: string): PlanMode {
  if (value === "balanced" || value === "dedupe-first") {
    return value;
  }
  throw new Error(`Invalid --mode value: ${value}. Expected 'balanced' or 'dedupe-first'.`);
}

function parseArgs(argv: string[]): ParsedCliOptions {
  let repo = DEFAULT_REPO;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let targetDecisions = DEFAULT_TARGET_DECISIONS;
  let useCache = false;
  let live = false;
  let mode: PlanMode = "dedupe-first";

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--repo") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --repo value");
      }
      repo = next;
      index++;
      continue;
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
    if (arg === "--target") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --target value");
      }
      targetDecisions = parsePositiveInt(next, "--target");
      index++;
      continue;
    }
    if (arg === "--mode") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --mode value");
      }
      mode = parseMode(next);
      index++;
      continue;
    }
    if (arg === "--use-cache") {
      useCache = true;
      continue;
    }
    if (arg === "--live") {
      live = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (useCache && live) {
    throw new Error("Use either --use-cache or --live, not both");
  }

  return { repo, outputDir, targetDecisions, useCache, live, mode };
}

function readOpenPrCacheMeta(path: string): OpenPrCacheMeta | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const repo = (raw as { repo?: unknown }).repo;
    const lastSyncAt = (raw as { lastSyncAt?: unknown }).lastSyncAt;
    const lastFullSyncAt = (raw as { lastFullSyncAt?: unknown }).lastFullSyncAt;
    const lastMode = (raw as { lastMode?: unknown }).lastMode;
    const totalOpen = (raw as { totalOpen?: unknown }).totalOpen;
    const watermark = (raw as { watermark?: unknown }).watermark;

    if (
      typeof repo !== "string" ||
      typeof lastSyncAt !== "string" ||
      typeof lastFullSyncAt !== "string" ||
      (lastMode !== "full" && lastMode !== "incremental") ||
      typeof totalOpen !== "number"
    ) {
      return null;
    }

    return {
      repo,
      lastSyncAt,
      lastFullSyncAt,
      lastMode,
      totalOpen,
      watermark: typeof watermark === "string" && watermark.length > 0 ? watermark : null,
    };
  } catch {
    return null;
  }
}

function shouldRunFullSync(input: {
  repo: string;
  nowMs: number;
  cacheMeta: OpenPrCacheMeta | null;
}): { runFullSync: boolean; reason: string } {
  const { repo, nowMs, cacheMeta } = input;
  if (!cacheMeta) {
    return { runFullSync: true, reason: "no cache metadata yet" };
  }
  if (cacheMeta.repo !== repo) {
    return { runFullSync: true, reason: `repo changed (${cacheMeta.repo} -> ${repo})` };
  }
  const lastFullMs = Date.parse(cacheMeta.lastFullSyncAt);
  if (!Number.isFinite(lastFullMs)) {
    return { runFullSync: true, reason: "invalid lastFullSyncAt in metadata" };
  }
  if (nowMs - lastFullMs >= FULL_SYNC_INTERVAL_MS) {
    return { runFullSync: true, reason: "full sync interval elapsed" };
  }
  return { runFullSync: false, reason: "recent full sync available" };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const progress = createProgressLogger();
  const repo = options.repo;

  const outputDir = resolveMaintainersPath(options.outputDir);
  progress.log(
    `Starting plan: repo=${repo}, mode=${options.mode}, target=${options.targetDecisions}, out=${outputDir}`,
  );
  progress.runStage("Preparing output directory", () => {
    mkdirSync(outputDir, { recursive: true });
  });

  const cachedOpenPrPath = resolve(outputDir, "open-prs.jsonl");
  const cacheMetaPath = resolve(outputDir, OPEN_PR_CACHE_META_FILE);
  const cacheExists = existsSync(cachedOpenPrPath);
  const preferCache = !options.live && !options.useCache && cacheExists;
  let sourceLabel = "live-full";
  let liveMode: "full" | "incremental" | null = null;
  const openPullRequests = progress.runStage("Loading open PR snapshot", () => {
    if (options.useCache) {
      return readCachedOpenPullRequests(cachedOpenPrPath);
    }
    if (preferCache) {
      return readCachedOpenPullRequests(cachedOpenPrPath);
    }
    if (!cacheExists) {
      liveMode = "full";
      return fetchOpenPullRequests(repo);
    }

    const cachedOpenPullRequests = readCachedOpenPullRequests(cachedOpenPrPath);
    const cacheMeta = readOpenPrCacheMeta(cacheMetaPath);
    const fullSyncDecision = shouldRunFullSync({ repo, nowMs: Date.now(), cacheMeta });
    if (fullSyncDecision.runFullSync) {
      progress.log(`Live refresh mode: full sync (${fullSyncDecision.reason})`);
      liveMode = "full";
      return fetchOpenPullRequests(repo);
    }

    const refresh = refreshOpenPullRequestsFromCache(repo, cachedOpenPullRequests, {
      onProgress: (message) => progress.log(message),
    });
    liveMode = refresh.mode;
    return refresh.pullRequests;
  });

  if (options.live || (!options.useCache && !preferCache)) {
    progress.runStage("Updating open PR cache", () => {
      writeJsonLines(cachedOpenPrPath, openPullRequests);
      const nowIso = new Date().toISOString();
      const newestUpdatedAt = computeOpenPullRequestWatermark(openPullRequests);
      const cacheMeta = readOpenPrCacheMeta(cacheMetaPath);
      const currentMode = liveMode ?? "full";
      writeJson(cacheMetaPath, {
        repo,
        lastSyncAt: nowIso,
        lastFullSyncAt:
          currentMode === "full" ? nowIso : (cacheMeta?.lastFullSyncAt ?? nowIso),
        lastMode: currentMode,
        totalOpen: openPullRequests.length,
        watermark: newestUpdatedAt,
      } satisfies OpenPrCacheMeta);
    });
    sourceLabel = liveMode === "incremental" ? "live-incremental" : "live-full";
  } else if (options.useCache) {
    sourceLabel = "cache-only";
  } else {
    sourceLabel = "cache-first";
  }
  progress.log(`Open PR source: ${sourceLabel} (${openPullRequests.length} PRs)`);

  const useCacheOnlyForDiffs = !sourceLabel.startsWith("live");
  const analysis = progress.runStage("Analyzing PRs and building clusters", () =>
    analyzePullRequests(repo, openPullRequests),
  );
  progress.log(`Detected ${analysis.clusters.length} clusters from ${analysis.totalOpen} open PRs`);
  const refinements = progress.runStage("Refining clusters with diff overlap", () =>
    computeClusterRefinements(repo, analysis.clusters, outputDir, useCacheOnlyForDiffs),
  );
  const plan = progress.runStage("Building daily review plan", () =>
    buildDailyPlan(analysis, options.targetDecisions, refinements, options.mode),
  );
  const planWithPolicyFlags = progress.runStage("Applying policy flags", () =>
    applyPolicyFlagsToPlan(repo, analysis, plan, outputDir, useCacheOnlyForDiffs),
  );

  progress.runStage("Writing plan artifacts", () => {
    writeJson(resolve(outputDir, "analysis.json"), analysis);
    writeJson(resolve(outputDir, "cluster-refinements.json"), refinements);
    writeJson(resolve(outputDir, "daily-plan.json"), planWithPolicyFlags);
    writeJson(resolve(outputDir, "clusters.json"), analysis.clusters);
    writeFileSync(
      resolve(outputDir, "daily-plan.md"),
      `${toMarkdown(analysis, planWithPolicyFlags)}\n`,
      "utf8",
    );
    writeFileSync(resolve(outputDir, "daily-queue.tsv"), toTsv(planWithPolicyFlags), "utf8");
  });

  progress.log(`Analyzed ${analysis.totalOpen} open PRs for ${analysis.repo}`);
  progress.log(`Plan mode: ${planWithPolicyFlags.mode}`);
  progress.log(
    `Selected ${planWithPolicyFlags.expectedReviews} reviews to drive ${planWithPolicyFlags.expectedDecisions} decisions`,
  );
  progress.log(`Artifacts written to ${outputDir}`);
  progress.log(`Plan complete in ${progress.summary()}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

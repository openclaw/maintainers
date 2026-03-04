#!/usr/bin/env -S node --import tsx

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_OUTPUT_DIR } from "../pr-ops/core/constants.ts";
import { resolveMaintainersPath } from "../pr-ops/core/paths.ts";
import {
  DECISION_OUTCOMES,
  DEFAULT_STATE_PATH,
  appendDecisionRecord,
  buildResolvedPrSet,
  computeAppliedMembersForDecision,
  findPlanItemByPrNumber,
  getClusterMembersExcluding,
  getNextUnresolvedItem,
  isCloseDecision,
  parseDecisionOutcome,
  parseRepoFromPrUrl,
  readDailyPlan,
  readDecisionLog,
} from "../pr-ops/state/decisions.ts";

type CliOptions = {
  outputDir: string;
  statePath: string;
  prNumber: number | null;
  decision: string | null;
  note: string;
  single: boolean;
  excludeRepresentative: boolean;
  autoCloseDuplicates: boolean;
};

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node --import tsx scripts/pr-decide.ts [options]",
      "",
      "Options:",
      `  --out <dir>             Plan output directory (default: ${DEFAULT_OUTPUT_DIR})`,
      `  --state <path>          Decision log path (default: ${DEFAULT_STATE_PATH})`,
      "  --pr <number>           PR number to decide (default: next unresolved queue item)",
      `  --decision <value>      Decision outcome (${DECISION_OUTCOMES.join("|")})`,
      "  --note <text>           Optional note stored in decision log",
      "  --single                Override auto scope and apply only to selected PR",
      "  --exclude-representative  Remove representative PR from computed target set",
      "  --auto-close-duplicates  With merge, also record close_duplicate for all other cluster members",
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
  let prNumber: number | null = null;
  let decision: string | null = null;
  let note = "";
  let single = false;
  let excludeRepresentative = false;
  let autoCloseDuplicates = false;

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
    if (arg === "--pr") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --pr value");
      }
      prNumber = parsePositiveInt(next, "--pr");
      index++;
      continue;
    }
    if (arg === "--decision") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --decision value");
      }
      decision = next;
      index++;
      continue;
    }
    if (arg === "--note") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --note value");
      }
      note = next;
      index++;
      continue;
    }
    if (arg === "--single") {
      single = true;
      continue;
    }
    if (arg === "--exclude-representative") {
      excludeRepresentative = true;
      continue;
    }
    if (arg === "--auto-close-duplicates") {
      autoCloseDuplicates = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!decision) {
    throw new Error(`Missing --decision value. Expected one of: ${DECISION_OUTCOMES.join(", ")}`);
  }

  return {
    outputDir,
    statePath,
    prNumber,
    decision,
    note,
    single,
    excludeRepresentative,
    autoCloseDuplicates,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const outcome = parseDecisionOutcome(options.decision ?? "");
  const outputDir = resolveMaintainersPath(options.outputDir);
  const statePath = resolveMaintainersPath(options.statePath);
  const planPath = resolve(outputDir, "daily-plan.json");
  const plan = readDailyPlan(planPath);
  const records = readDecisionLog(statePath);
  const resolved = buildResolvedPrSet(records);

  const item =
    options.prNumber === null
      ? getNextUnresolvedItem(plan, resolved)
      : findPlanItemByPrNumber(plan, options.prNumber);

  if (!item) {
    throw new Error("No matching queue item found. Run scripts/pr-next to inspect the queue.");
  }

  const triggeredByNumber = options.prNumber ?? item.representativeNumber;
  if (options.autoCloseDuplicates && outcome !== "merge") {
    throw new Error("--auto-close-duplicates is only supported with --decision merge.");
  }

  const intendedMembers = computeAppliedMembersForDecision({
    item,
    triggeredByNumber,
    outcome,
    single: options.single,
    excludeRepresentative: options.excludeRepresentative,
  });
  const primaryAppliedTo = [...new Set(intendedMembers)].filter((number) => !resolved.has(number));
  const autoCloseDuplicateAppliedTo = options.autoCloseDuplicates
    ? getClusterMembersExcluding(item, triggeredByNumber)
        .filter((number) => !resolved.has(number))
        .filter((number) => !primaryAppliedTo.includes(number))
    : [];

  if (primaryAppliedTo.length === 0 && autoCloseDuplicateAppliedTo.length === 0) {
    console.log("No new PRs were marked because all target PRs are already resolved in state.");
    return;
  }

  const now = new Date().toISOString();
  const updatedResolved = new Set(resolved);
  const repo = parseRepoFromPrUrl(item.representativeUrl);
  const baseId = `${Date.now()}-${item.representativeNumber}-${Math.random().toString(16).slice(2, 8)}`;
  const buildRecord = (
    recordOutcome: typeof outcome,
    recordNote: string,
    recordTriggeredBy: number,
    appliedTo: number[],
    suffix: string,
  ) =>
    ({
      id: `${baseId}-${suffix}`,
      decidedAt: now,
      actor: process.env.USER ?? "unknown",
      repo,
      outcome: recordOutcome,
      note: recordNote,
      lane: item.lane,
      representativeNumber: item.representativeNumber,
      originNumber: item.originNumber,
      triggeredByNumber: recordTriggeredBy,
      clusterId: item.clusterId,
      title: item.title,
      url: item.representativeUrl,
      appliedTo,
    }) as const;

  if (primaryAppliedTo.length > 0) {
    appendDecisionRecord(
      statePath,
      buildRecord(outcome, options.note, triggeredByNumber, primaryAppliedTo, "primary"),
    );
    for (const number of primaryAppliedTo) {
      updatedResolved.add(number);
    }
  }

  if (autoCloseDuplicateAppliedTo.length > 0) {
    const autoCloseNote =
      options.note.trim().length > 0
        ? `${options.note} | auto close duplicates of #${triggeredByNumber}`
        : `auto close duplicates of #${triggeredByNumber}`;
    appendDecisionRecord(
      statePath,
      buildRecord(
        "close_duplicate",
        autoCloseNote,
        triggeredByNumber,
        autoCloseDuplicateAppliedTo,
        "auto-close-duplicates",
      ),
    );
    for (const number of autoCloseDuplicateAppliedTo) {
      updatedResolved.add(number);
    }
  }
  const next = getNextUnresolvedItem(plan, updatedResolved);

  if (primaryAppliedTo.length > 0) {
    console.log(
      `Recorded: ${outcome} on #${item.representativeNumber} (applied to ${primaryAppliedTo.length} PRs: ${primaryAppliedTo.join(", ")})`,
    );
  } else {
    console.log(`Recorded: ${outcome} skipped (already resolved in state).`);
  }
  if (autoCloseDuplicateAppliedTo.length > 0) {
    console.log(
      `Recorded: close_duplicate (auto) for #${triggeredByNumber} (applied to ${autoCloseDuplicateAppliedTo.length} PRs: ${autoCloseDuplicateAppliedTo.join(", ")})`,
    );
  } else if (options.autoCloseDuplicates) {
    console.log("Auto-close duplicates: no unresolved duplicate members in this cluster.");
  }
  if (isCloseDecision(outcome) && item.clusterMembers.length > 1) {
    console.log(
      "Note: this updates local decision state only. Ensure duplicate PRs are actually closed on GitHub.",
    );
  }
  if (autoCloseDuplicateAppliedTo.length > 0) {
    console.log(
      "Note: this updates local decision state only. Ensure duplicate PRs are actually closed on GitHub.",
    );
  }
  if (next) {
    console.log(
      `Next: scripts/pr-decide --out ${options.outputDir} --state ${options.statePath} --decision <${DECISION_OUTCOMES.join("|")}> --pr ${next.representativeNumber}`,
    );
  } else {
    console.log("Queue complete: all planned items are now resolved in state log.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

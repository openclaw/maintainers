import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { DailyPlan, Lane, PlanItem, PlanMode } from "../core/types.ts";

export const DEFAULT_STATE_PATH = "pr-ops/state/decisions.jsonl";
export const DECISION_OUTCOMES = [
  "merge",
  "approve",
  "request_changes",
  "close_duplicate",
  "close_not_planned",
  "defer",
] as const;

export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export type DecisionRecord = {
  id: string;
  decidedAt: string;
  actor: string;
  repo: string | null;
  outcome: DecisionOutcome;
  note: string;
  lane: Lane;
  representativeNumber: number;
  originNumber: number | null;
  triggeredByNumber: number;
  clusterId: string | null;
  title: string;
  url: string;
  appliedTo: number[];
};

export function isMergeLikeDecision(outcome: DecisionOutcome): boolean {
  return outcome === "merge" || outcome === "approve" || outcome === "request_changes";
}

export function isCloseDecision(outcome: DecisionOutcome): boolean {
  return outcome === "close_duplicate" || outcome === "close_not_planned";
}

function parseJsonLines<T>(contents: string): T[] {
  const rows: T[] = [];
  const lines = contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // Ignore malformed historical lines to keep workflow robust.
    }
  }
  return rows;
}

function normalizeNumberArray(input: unknown): number[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const values: number[] = [];
  for (const item of input) {
    const parsed = Number(item);
    if (Number.isFinite(parsed) && parsed > 0) {
      values.push(Math.trunc(parsed));
    }
  }
  return [...new Set(values)];
}

function normalizeDecisionOutcome(value: unknown): DecisionOutcome | null {
  if (typeof value !== "string") {
    return null;
  }
  return DECISION_OUTCOMES.includes(value as DecisionOutcome) ? (value as DecisionOutcome) : null;
}

function normalizeDecisionRecord(raw: unknown): DecisionRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const outcome = normalizeDecisionOutcome((raw as { outcome?: unknown }).outcome);
  if (!outcome) {
    return null;
  }

  const representativeNumber = Number(
    (raw as { representativeNumber?: unknown }).representativeNumber,
  );
  if (!Number.isFinite(representativeNumber) || representativeNumber <= 0) {
    return null;
  }

  const laneValue = (raw as { lane?: unknown }).lane;
  const lane: Lane =
    laneValue === "cluster" || laneValue === "fast" || laneValue === "deep" ? laneValue : "fast";

  const appliedTo = normalizeNumberArray((raw as { appliedTo?: unknown }).appliedTo);
  if (appliedTo.length === 0) {
    return null;
  }

  const originRaw = Number((raw as { originNumber?: unknown }).originNumber);
  const originNumber = Number.isFinite(originRaw) && originRaw > 0 ? Math.trunc(originRaw) : null;

  const clusterIdRaw = (raw as { clusterId?: unknown }).clusterId;
  const clusterId =
    typeof clusterIdRaw === "string" && clusterIdRaw.length > 0 ? clusterIdRaw : null;

  const idRaw = (raw as { id?: unknown }).id;
  const decidedAtRaw = (raw as { decidedAt?: unknown }).decidedAt;
  const actorRaw = (raw as { actor?: unknown }).actor;
  const titleRaw = (raw as { title?: unknown }).title;
  const urlRaw = (raw as { url?: unknown }).url;
  const noteRaw = (raw as { note?: unknown }).note;
  const repoRaw = (raw as { repo?: unknown }).repo;
  const triggeredRaw = Number((raw as { triggeredByNumber?: unknown }).triggeredByNumber);

  return {
    id: typeof idRaw === "string" && idRaw.length > 0 ? idRaw : "unknown",
    decidedAt:
      typeof decidedAtRaw === "string" && decidedAtRaw.length > 0
        ? decidedAtRaw
        : new Date(0).toISOString(),
    actor: typeof actorRaw === "string" && actorRaw.length > 0 ? actorRaw : "unknown",
    repo: typeof repoRaw === "string" && repoRaw.length > 0 ? repoRaw : null,
    outcome,
    note: typeof noteRaw === "string" ? noteRaw : "",
    lane,
    representativeNumber: Math.trunc(representativeNumber),
    originNumber,
    triggeredByNumber:
      Number.isFinite(triggeredRaw) && triggeredRaw > 0
        ? Math.trunc(triggeredRaw)
        : Math.trunc(representativeNumber),
    clusterId,
    title: typeof titleRaw === "string" ? titleRaw : "",
    url: typeof urlRaw === "string" ? urlRaw : "",
    appliedTo,
  };
}

function inferMode(input: unknown): PlanMode {
  return input === "balanced" ? "balanced" : "dedupe-first";
}

function computeDerivedMetrics(selected: PlanItem[]) {
  const expectedDecisions = selected.reduce((sum, item) => sum + item.decisionGain, 0);
  const expectedReviews = selected.length;
  const expectedClusterDecisions = selected
    .filter((item) => item.lane === "cluster")
    .reduce((sum, item) => sum + item.decisionGain, 0);
  const expectedSingleDecisions = Math.max(0, expectedDecisions - expectedClusterDecisions);
  const decisionGainRatio = expectedReviews === 0 ? 0 : expectedDecisions / expectedReviews;
  return {
    expectedDecisions,
    expectedReviews,
    expectedClusterDecisions,
    expectedSingleDecisions,
    decisionGainRatio,
  };
}

export function parseDecisionOutcome(value: string): DecisionOutcome {
  const outcome = normalizeDecisionOutcome(value);
  if (!outcome) {
    throw new Error(
      `Invalid --decision value: ${value}. Expected one of: ${DECISION_OUTCOMES.join(", ")}`,
    );
  }
  return outcome;
}

export function readDecisionLog(path: string): DecisionRecord[] {
  if (!existsSync(path)) {
    return [];
  }
  const rows = parseJsonLines<unknown>(readFileSync(path, "utf8"));
  return rows
    .map((row) => normalizeDecisionRecord(row))
    .filter((row): row is DecisionRecord => row !== null);
}

export function appendDecisionRecord(path: string, record: DecisionRecord) {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

export function buildResolvedPrSet(records: DecisionRecord[]): Set<number> {
  const resolved = new Set<number>();
  for (const record of records) {
    for (const number of record.appliedTo) {
      resolved.add(number);
    }
  }
  return resolved;
}

export function findPlanItemByPrNumber(plan: DailyPlan, prNumber: number): PlanItem | null {
  for (const item of plan.selected) {
    if (item.representativeNumber === prNumber) {
      return item;
    }
    if (item.clusterMembers.includes(prNumber)) {
      return item;
    }
  }
  return null;
}

export function getClusterDuplicateMembers(item: PlanItem): number[] {
  const originNumber = item.originNumber ?? item.representativeNumber;
  return getClusterMembersExcluding(item, originNumber);
}

export function getClusterMembersExcluding(item: PlanItem, excludedNumber: number): number[] {
  const members =
    item.clusterMembers.length > 0 ? [...item.clusterMembers] : [item.representativeNumber];
  return [...new Set(members)].filter((number) => number !== excludedNumber);
}

export function computeAppliedMembersForDecision(input: {
  item: PlanItem;
  triggeredByNumber: number;
  outcome: DecisionOutcome;
  single: boolean;
  excludeRepresentative: boolean;
}): number[] {
  const { item, triggeredByNumber, outcome, single, excludeRepresentative } = input;
  const clusterMembers =
    item.clusterMembers.length > 0 ? [...item.clusterMembers] : [item.representativeNumber];
  let members: number[];

  if (single || outcome === "defer" || isMergeLikeDecision(outcome)) {
    members = [triggeredByNumber];
  } else if (outcome === "close_duplicate") {
    // Auto scope: duplicate close should target duplicate members, not the origin PR.
    members = getClusterDuplicateMembers(item);
    if (members.length === 0) {
      members = clusterMembers.includes(triggeredByNumber)
        ? [triggeredByNumber]
        : [item.representativeNumber];
    }
  } else if (outcome === "close_not_planned") {
    members = [triggeredByNumber];
  } else {
    members = [triggeredByNumber];
  }

  if (excludeRepresentative) {
    members = members.filter((number) => number !== item.representativeNumber);
  }

  return [...new Set(members)];
}

export function isPlanItemResolved(item: PlanItem, resolvedPrs: Set<number>): boolean {
  const members =
    item.clusterMembers.length > 0 ? item.clusterMembers : [item.representativeNumber];
  for (const member of members) {
    if (!resolvedPrs.has(member)) {
      return false;
    }
  }
  return true;
}

export function getNextUnresolvedItem(plan: DailyPlan, resolvedPrs: Set<number>): PlanItem | null {
  for (const item of plan.selected) {
    if (!isPlanItemResolved(item, resolvedPrs)) {
      return item;
    }
  }
  return null;
}

export function parseRepoFromPrUrl(url: string): string | null {
  const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/);
  return match?.[1] ?? null;
}

export function readDailyPlan(path: string): DailyPlan {
  if (!existsSync(path)) {
    throw new Error(`Plan file not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid plan JSON: ${path}`);
  }

  const selected = Array.isArray((raw as { selected?: unknown }).selected)
    ? ((raw as { selected: unknown[] }).selected as PlanItem[])
    : [];

  const derived = computeDerivedMetrics(selected);
  const targetRaw = Number((raw as { targetDecisions?: unknown }).targetDecisions);
  const laneTotalsRaw = (raw as { laneTotals?: unknown }).laneTotals;
  const laneTotals =
    laneTotalsRaw && typeof laneTotalsRaw === "object"
      ? {
          cluster: Number((laneTotalsRaw as { cluster?: unknown }).cluster ?? 0) || 0,
          fast: Number((laneTotalsRaw as { fast?: unknown }).fast ?? 0) || 0,
          deep: Number((laneTotalsRaw as { deep?: unknown }).deep ?? 0) || 0,
        }
      : { cluster: 0, fast: 0, deep: 0 };

  return {
    mode: inferMode((raw as { mode?: unknown }).mode),
    targetDecisions: Number.isFinite(targetRaw) && targetRaw > 0 ? Math.trunc(targetRaw) : 1,
    expectedDecisions:
      Number((raw as { expectedDecisions?: unknown }).expectedDecisions) ||
      derived.expectedDecisions,
    expectedReviews:
      Number((raw as { expectedReviews?: unknown }).expectedReviews) || derived.expectedReviews,
    expectedClusterDecisions:
      Number((raw as { expectedClusterDecisions?: unknown }).expectedClusterDecisions) ||
      derived.expectedClusterDecisions,
    expectedSingleDecisions:
      Number((raw as { expectedSingleDecisions?: unknown }).expectedSingleDecisions) ||
      derived.expectedSingleDecisions,
    decisionGainRatio:
      Number((raw as { decisionGainRatio?: unknown }).decisionGainRatio) ||
      derived.decisionGainRatio,
    laneTotals,
    selected,
  };
}

export function computeDecisionStats(plan: DailyPlan, records: DecisionRecord[]) {
  const resolved = buildResolvedPrSet(records);
  const uniqueReviewed = new Set(records.map((record) => record.representativeNumber));
  const resolvedQueueItems = plan.selected.filter((item) =>
    isPlanItemResolved(item, resolved),
  ).length;
  const clusterMemberSet = new Set<number>(
    plan.selected.filter((item) => item.lane === "cluster").flatMap((item) => item.clusterMembers),
  );

  let resolvedClusterDecisions = 0;
  for (const number of resolved) {
    if (clusterMemberSet.has(number)) {
      resolvedClusterDecisions++;
    }
  }
  const resolvedSingleDecisions = Math.max(0, resolved.size - resolvedClusterDecisions);
  const decisionGainRatio = uniqueReviewed.size === 0 ? 0 : resolved.size / uniqueReviewed.size;

  return {
    mode: plan.mode,
    targetDecisions: plan.targetDecisions,
    plannedDecisions: plan.expectedDecisions,
    plannedReviews: plan.expectedReviews,
    records: records.length,
    activeReviews: uniqueReviewed.size,
    totalDecisions: resolved.size,
    resolvedClusterDecisions,
    resolvedSingleDecisions,
    decisionGainRatio,
    dedupeSavings: Math.max(0, resolved.size - uniqueReviewed.size),
    queueSize: plan.selected.length,
    resolvedQueueItems,
    remainingQueueItems: Math.max(0, plan.selected.length - resolvedQueueItems),
    remainingDecisionsToTarget: Math.max(0, plan.targetDecisions - resolved.size),
  };
}

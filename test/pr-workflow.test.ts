import { describe, expect, it } from "vitest";

import type { DailyPlan } from "../pr-ops/core/types.ts";
import {
  buildResolvedPrSet,
  computeAppliedMembersForDecision,
  computeDecisionStats,
  findPlanItemByPrNumber,
  getClusterMembersExcluding,
  getClusterDuplicateMembers,
  getNextUnresolvedItem,
  parseDecisionOutcome,
} from "../pr-ops/state/decisions.ts";

function samplePlan(): DailyPlan {
  return {
    mode: "dedupe-first",
    targetDecisions: 5,
    expectedDecisions: 5,
    expectedReviews: 3,
    expectedClusterDecisions: 3,
    expectedSingleDecisions: 2,
    decisionGainRatio: 5 / 3,
    laneTotals: { cluster: 3, fast: 2, deep: 0 },
    selected: [
      {
        lane: "cluster",
        representativeNumber: 10,
        originNumber: 10,
        representativeUrl: "https://github.com/openclaw/openclaw/pull/10",
        title: "fix(gateway): dedupe retries",
        author: "a",
        risk: "medium",
        effort: 2,
        decisionGain: 3,
        clusterId: "cluster-1",
        clusterMembers: [10, 11, 12],
        clusterConfidence: "high",
        clusterCoverage: 1,
        policyFlags: [],
        rationale: ["cluster"],
      },
      {
        lane: "fast",
        representativeNumber: 20,
        originNumber: null,
        representativeUrl: "https://github.com/openclaw/openclaw/pull/20",
        title: "docs: update readme",
        author: "b",
        risk: "low",
        effort: 1,
        decisionGain: 1,
        clusterId: null,
        clusterMembers: [20],
        clusterConfidence: null,
        clusterCoverage: null,
        policyFlags: [],
        rationale: ["single"],
      },
      {
        lane: "fast",
        representativeNumber: 21,
        originNumber: null,
        representativeUrl: "https://github.com/openclaw/openclaw/pull/21",
        title: "fix: typo",
        author: "c",
        risk: "low",
        effort: 1,
        decisionGain: 1,
        clusterId: null,
        clusterMembers: [21],
        clusterConfidence: null,
        clusterCoverage: null,
        policyFlags: [],
        rationale: ["single"],
      },
    ],
  };
}

describe("state workflow helpers", () => {
  it("resolves cluster fan-out and returns next unresolved item", () => {
    const plan = samplePlan();
    const records = [
      {
        id: "1",
        decidedAt: "2026-03-03T00:00:00.000Z",
        actor: "tester",
        repo: "openclaw/openclaw",
        outcome: "close_duplicate" as const,
        note: "",
        lane: "cluster" as const,
        representativeNumber: 10,
        originNumber: 10,
        triggeredByNumber: 10,
        clusterId: "cluster-1",
        title: "fix(gateway): dedupe retries",
        url: "https://github.com/openclaw/openclaw/pull/10",
        appliedTo: [10, 11, 12],
      },
    ];

    const resolved = buildResolvedPrSet(records);
    expect(findPlanItemByPrNumber(plan, 11)?.representativeNumber).toBe(10);
    expect(getNextUnresolvedItem(plan, resolved)?.representativeNumber).toBe(20);
  });

  it("computes decision gain stats from decision log", () => {
    const plan = samplePlan();
    const records = [
      {
        id: "1",
        decidedAt: "2026-03-03T00:00:00.000Z",
        actor: "tester",
        repo: "openclaw/openclaw",
        outcome: "close_duplicate" as const,
        note: "",
        lane: "cluster" as const,
        representativeNumber: 10,
        originNumber: 10,
        triggeredByNumber: 10,
        clusterId: "cluster-1",
        title: "fix(gateway): dedupe retries",
        url: "https://github.com/openclaw/openclaw/pull/10",
        appliedTo: [10, 11, 12],
      },
      {
        id: "2",
        decidedAt: "2026-03-03T01:00:00.000Z",
        actor: "tester",
        repo: "openclaw/openclaw",
        outcome: "approve" as const,
        note: "",
        lane: "fast" as const,
        representativeNumber: 20,
        originNumber: null,
        triggeredByNumber: 20,
        clusterId: null,
        title: "docs: update readme",
        url: "https://github.com/openclaw/openclaw/pull/20",
        appliedTo: [20],
      },
    ];

    const stats = computeDecisionStats(plan, records);
    expect(stats.totalDecisions).toBe(4);
    expect(stats.activeReviews).toBe(2);
    expect(stats.decisionGainRatio).toBe(2);
    expect(stats.dedupeSavings).toBe(2);
    expect(stats.resolvedQueueItems).toBe(2);
    expect(stats.remainingQueueItems).toBe(1);
  });

  it("validates decision values", () => {
    expect(parseDecisionOutcome("merge")).toBe("merge");
    expect(parseDecisionOutcome("approve")).toBe("approve");
    expect(() => parseDecisionOutcome("ship-it")).toThrowError(/Invalid --decision value/);
  });

  it("auto-scopes decision targets by outcome", () => {
    const clusterItem = samplePlan().selected[0];
    const singleItem = samplePlan().selected[1];

    const mergeTargets = computeAppliedMembersForDecision({
      item: clusterItem,
      triggeredByNumber: clusterItem.representativeNumber,
      outcome: "merge",
      single: false,
      excludeRepresentative: false,
    });
    const closeDupTargets = computeAppliedMembersForDecision({
      item: clusterItem,
      triggeredByNumber: clusterItem.representativeNumber,
      outcome: "close_duplicate",
      single: false,
      excludeRepresentative: false,
    });
    const closeNotPlannedTargets = computeAppliedMembersForDecision({
      item: clusterItem,
      triggeredByNumber: clusterItem.representativeNumber,
      outcome: "close_not_planned",
      single: false,
      excludeRepresentative: false,
    });
    const singleCloseDupTargets = computeAppliedMembersForDecision({
      item: singleItem,
      triggeredByNumber: singleItem.representativeNumber,
      outcome: "close_duplicate",
      single: false,
      excludeRepresentative: false,
    });

    expect(mergeTargets).toEqual([10]);
    expect(closeDupTargets.sort((left, right) => left - right)).toEqual([11, 12]);
    expect(closeNotPlannedTargets).toEqual([10]);
    expect(singleCloseDupTargets).toEqual([20]);
  });

  it("supports manual scope override flags when needed", () => {
    const clusterItem = samplePlan().selected[0];
    const forceSingleCloseDup = computeAppliedMembersForDecision({
      item: clusterItem,
      triggeredByNumber: clusterItem.representativeNumber,
      outcome: "close_duplicate",
      single: true,
      excludeRepresentative: false,
    });
    const excludeRepresentativeTargets = computeAppliedMembersForDecision({
      item: clusterItem,
      triggeredByNumber: clusterItem.representativeNumber,
      outcome: "close_duplicate",
      single: false,
      excludeRepresentative: true,
    });

    expect(forceSingleCloseDup).toEqual([10]);
    expect(excludeRepresentativeTargets.sort((left, right) => left - right)).toEqual([11, 12]);
  });

  it("derives duplicate members from cluster origin", () => {
    const clusterItem = samplePlan().selected[0];
    const singleItem = samplePlan().selected[1];
    expect(getClusterDuplicateMembers(clusterItem).sort((left, right) => left - right)).toEqual([
      11, 12,
    ]);
    expect(getClusterDuplicateMembers(singleItem)).toEqual([]);
    expect(getClusterMembersExcluding(clusterItem, 11).sort((left, right) => left - right)).toEqual(
      [10, 12],
    );
  });
});

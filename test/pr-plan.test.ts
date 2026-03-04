import { describe, expect, it } from "vitest";
import {
  buildClusters,
  buildDailyPlan,
  detectPolicyFlags,
  normalizeTitleForClustering,
  type OpenPullRequest,
} from "../scripts/pr-plan.ts";

function pr(
  number: number,
  title: string,
  overrides: Partial<OpenPullRequest> = {},
): OpenPullRequest {
  return {
    number,
    title,
    body: "",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T01:00:00Z",
    draft: false,
    url: `https://github.com/openclaw/openclaw/pull/${number}`,
    author: "someone",
    authorAssociation: "NONE",
    headRepo: "fork/repo",
    headRef: `branch-${number}`,
    baseRef: "main",
    ...overrides,
  };
}

describe("normalizeTitleForClustering", () => {
  it("strips conventional prefix and PR references", () => {
    expect(normalizeTitleForClustering("fix(gateway): Handle Timeout (#12345)")).toBe(
      "handle timeout",
    );
  });
});

describe("buildClusters", () => {
  it("clusters exact and near-title duplicates", () => {
    const input = [
      pr(1, "fix(signal): add group-level allowlist support via groups config"),
      pr(2, "fix(signal): add allowlist support via group config"),
      pr(3, "fix(signal): add group-level allowlist support via groups config (#1)"),
      pr(4, "docs: update readme getting-started section"),
    ];

    const { clusters, pullRequests } = buildClusters(input, Date.parse("2026-03-03T00:00:00Z"));
    expect(clusters.length).toBe(1);
    expect(clusters[0]?.memberNumbers.sort((left, right) => left - right)).toEqual([1, 2, 3]);
    expect(pullRequests.find((item) => item.number === 4)?.clusterSize).toBe(1);
  });
});

describe("buildDailyPlan", () => {
  it("uses cluster fan-out to hit decision targets with fewer active reviews", () => {
    const open = [
      pr(10, "fix(gateway): dedupe webhook retries"),
      pr(11, "fix(gateway): dedupe webhook retries (#10)"),
      pr(12, "fix(gateway): dedupe webhook retries in local mode"),
      pr(13, "docs: clarify gateway onboarding"),
      pr(14, "fix(auth): rotate token when key expires"),
    ];

    const nowMs = Date.parse("2026-03-03T00:00:00Z");
    const clusterBuild = buildClusters(open, nowMs);
    const analysis = {
      generatedAt: "2026-03-03T00:00:00Z",
      repo: "openclaw/openclaw",
      totalOpen: clusterBuild.pullRequests.length,
      draftCount: 0,
      readyCount: clusterBuild.pullRequests.length,
      likelyAutomationCount: clusterBuild.pullRequests.filter((item) => item.likelyAutomation)
        .length,
      highRiskCount: clusterBuild.pullRequests.filter((item) => item.risk === "high").length,
      mediumRiskCount: clusterBuild.pullRequests.filter((item) => item.risk === "medium").length,
      lowRiskCount: clusterBuild.pullRequests.filter((item) => item.risk === "low").length,
      uniqueAuthors: 1,
      topAuthors: [{ author: "someone", openCount: 5 }],
      clusters: clusterBuild.clusters,
      pullRequests: clusterBuild.pullRequests,
    };

    const refinements = clusterBuild.clusters.map((cluster) => ({
      clusterId: cluster.id,
      confidence: "high" as const,
      anchorNumber: cluster.originNumber,
      comparedMembers: Math.max(0, cluster.memberNumbers.length - 1),
      memberCount: cluster.memberNumbers.length,
      coverage: 1,
      averageSimilarity: 0.8,
      minimumSimilarity: 0.6,
      representativeNumber: cluster.representativeNumber,
    }));

    const plan = buildDailyPlan(analysis, 4, refinements, "dedupe-first");
    expect(plan.mode).toBe("dedupe-first");
    expect(plan.expectedDecisions).toBeGreaterThanOrEqual(4);
    expect(plan.expectedReviews).toBeLessThan(plan.expectedDecisions);
    expect(plan.expectedClusterDecisions).toBeGreaterThan(0);
    expect(plan.decisionGainRatio).toBeGreaterThan(1);
    expect(plan.selected.some((item) => item.lane === "cluster" && item.decisionGain >= 3)).toBe(
      true,
    );
  });
});

describe("detectPolicyFlags", () => {
  it("flags vendor-defaulting behavior in core paths", () => {
    const flags = detectPolicyFlags({
      title: "feat: firecrawl onboarding with browser defaults",
      body: "setup auto-enables alsoAllow and shifts default browser profile",
      files: [
        "src/commands/onboard-firecrawl.ts",
        "src/wizard/onboarding.ts",
        "src/browser/config.ts",
        "src/agents/openclaw-tools.ts",
      ],
    });

    expect(flags).toEqual(
      expect.arrayContaining([
        "vendor_lockin_default_path",
        "auto_enable_vendor_tools",
        "default_profile_shift",
        "vendor_core_not_optional",
      ]),
    );
  });

  it("does not flag vendor additions outside default-path surfaces", () => {
    const flags = detectPolicyFlags({
      title: "feat(tools): add EXA as web search provider",
      body: "adds provider support to web search tool catalog",
      files: [
        "src/agents/tools/web-search.ts",
        "src/config/types.tools.ts",
        "src/config/zod-schema.agent-runtime.ts",
      ],
    });

    expect(flags).toEqual([]);
  });
});

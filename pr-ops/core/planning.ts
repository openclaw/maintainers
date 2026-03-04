import { hydrateDiffDataForPrNumbers } from "../github/client.ts";
import { detectPolicyFlags } from "./policy.ts";
import type {
  AnalysisResult,
  ClusterConfidence,
  ClusterRefinement,
  DailyPlan,
  DerivedPullRequest,
  Lane,
  PlanMode,
  PolicyFlag,
} from "./types.ts";

function clusterPriorityScore(
  pr: DerivedPullRequest,
  confidence: ClusterConfidence = "unknown",
): number {
  const confidenceBonus =
    confidence === "high" ? 20 : confidence === "medium" ? 8 : confidence === "low" ? -40 : -12;
  return (
    pr.clusterSize * 100 +
    (pr.likelyAutomation ? 20 : 0) +
    pr.authorRecentOpenCount * 2 -
    pr.effort * 10 +
    confidenceBonus
  );
}

function fastPriorityScore(pr: DerivedPullRequest): number {
  let score = 50;
  score += pr.likelyAutomation ? 30 : 0;
  score += Math.max(0, 24 - pr.ageHours / 6);
  score += Math.min(20, pr.authorRecentOpenCount * 2);
  score -= pr.effort * 8;
  score -= pr.risk === "medium" ? 12 : 0;
  return score;
}

function deepPriorityScore(pr: DerivedPullRequest): number {
  let score = 40;
  score += pr.risk === "high" ? 35 : 0;
  score += Math.min(20, pr.ageHours / 12);
  score += Math.min(10, pr.authorRecentOpenCount);
  score -= pr.effort * 3;
  return score;
}

export function buildDailyPlan(
  analysis: AnalysisResult,
  targetDecisions: number,
  refinements: ClusterRefinement[] = [],
  mode: PlanMode = "dedupe-first",
): DailyPlan {
  const clusterTarget =
    mode === "balanced" ? Math.max(0, Math.round(targetDecisions * 0.6)) : targetDecisions;
  const fastTarget =
    mode === "balanced" ? Math.max(0, Math.round(targetDecisions * 0.3)) : Number.POSITIVE_INFINITY;
  const deepTarget =
    mode === "balanced"
      ? Math.max(0, targetDecisions - clusterTarget - fastTarget)
      : Number.POSITIVE_INFINITY;

  const prByNumber = new Map(analysis.pullRequests.map((pr) => [pr.number, pr]));
  const refinementByClusterId = new Map(refinements.map((item) => [item.clusterId, item]));
  const selectedNumbers = new Set<number>();
  const selected: DailyPlan["selected"] = [];
  const laneTotals = { cluster: 0, fast: 0, deep: 0 };
  let expectedDecisions = 0;

  const clusterCandidates = analysis.clusters
    .map((cluster) => {
      const representative = prByNumber.get(cluster.representativeNumber);
      if (!representative || representative.draft) {
        return null;
      }
      const refinement = refinementByClusterId.get(cluster.id);
      const confidence = refinement?.confidence ?? "unknown";
      if (confidence === "low" || confidence === "unknown") {
        return null;
      }
      return {
        cluster,
        representative,
        refinement,
        score: clusterPriorityScore(representative, refinement?.confidence ?? "unknown"),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => right.score - left.score);

  for (const candidate of clusterCandidates) {
    if (expectedDecisions >= targetDecisions || laneTotals.cluster >= clusterTarget) {
      break;
    }
    const gain = candidate.cluster.memberNumbers.length;
    selected.push({
      lane: "cluster",
      representativeNumber: candidate.representative.number,
      originNumber: candidate.cluster.originNumber,
      representativeUrl: candidate.representative.url,
      title: candidate.representative.title,
      author: candidate.representative.author,
      risk: candidate.representative.risk,
      effort: candidate.representative.effort,
      decisionGain: gain,
      clusterId: candidate.cluster.id,
      clusterMembers: candidate.cluster.memberNumbers,
      clusterConfidence: candidate.refinement?.confidence ?? "unknown",
      clusterCoverage: candidate.refinement?.coverage ?? null,
      policyFlags: [],
      rationale: [
        `${candidate.cluster.reason.replace("_", " ")} cluster (${gain} PRs)`,
        `file overlap confidence: ${candidate.refinement?.confidence ?? "unknown"}`,
        `origin PR: #${candidate.cluster.originNumber}`,
      ],
    });
    for (const number of candidate.cluster.memberNumbers) {
      selectedNumbers.add(number);
    }
    expectedDecisions += gain;
    laneTotals.cluster += gain;
  }

  const singles = analysis.pullRequests
    .filter((pr) => !pr.draft && !selectedNumbers.has(pr.number))
    .map((pr) => ({ pr }));

  const fastSingles = singles
    .filter((item) => item.pr.risk !== "high")
    .sort((left, right) => fastPriorityScore(right.pr) - fastPriorityScore(left.pr));

  for (const item of fastSingles) {
    if (expectedDecisions >= targetDecisions || laneTotals.fast >= fastTarget) {
      break;
    }
    selected.push({
      lane: "fast",
      representativeNumber: item.pr.number,
      originNumber: null,
      representativeUrl: item.pr.url,
      title: item.pr.title,
      author: item.pr.author,
      risk: item.pr.risk,
      effort: item.pr.effort,
      decisionGain: 1,
      clusterId: null,
      clusterMembers: [item.pr.number],
      clusterConfidence: null,
      clusterCoverage: null,
      policyFlags: [],
      rationale: [
        item.pr.likelyAutomation ? "likely automation/update pattern" : "single low/medium-risk PR",
      ],
    });
    selectedNumbers.add(item.pr.number);
    expectedDecisions += 1;
    laneTotals.fast += 1;
  }

  const deepSingles = singles
    .filter((item) => item.pr.risk === "high" && !selectedNumbers.has(item.pr.number))
    .sort((left, right) => deepPriorityScore(right.pr) - deepPriorityScore(left.pr));

  for (const item of deepSingles) {
    if (expectedDecisions >= targetDecisions || laneTotals.deep >= deepTarget) {
      break;
    }
    selected.push({
      lane: "deep",
      representativeNumber: item.pr.number,
      originNumber: null,
      representativeUrl: item.pr.url,
      title: item.pr.title,
      author: item.pr.author,
      risk: item.pr.risk,
      effort: item.pr.effort,
      decisionGain: 1,
      clusterId: null,
      clusterMembers: [item.pr.number],
      clusterConfidence: null,
      clusterCoverage: null,
      policyFlags: [],
      rationale: ["high-risk path keyword in title/body"],
    });
    selectedNumbers.add(item.pr.number);
    expectedDecisions += 1;
    laneTotals.deep += 1;
  }

  if (expectedDecisions < targetDecisions) {
    const remainder = [...fastSingles, ...deepSingles]
      .map((item) => item.pr)
      .filter((pr) => !selectedNumbers.has(pr.number))
      .sort((left, right) => fastPriorityScore(right) - fastPriorityScore(left));

    for (const pr of remainder) {
      if (expectedDecisions >= targetDecisions) {
        break;
      }
      const lane: Lane = pr.risk === "high" ? "deep" : "fast";
      selected.push({
        lane,
        representativeNumber: pr.number,
        originNumber: null,
        representativeUrl: pr.url,
        title: pr.title,
        author: pr.author,
        risk: pr.risk,
        effort: pr.effort,
        decisionGain: 1,
        clusterId: null,
        clusterMembers: [pr.number],
        clusterConfidence: null,
        clusterCoverage: null,
        policyFlags: [],
        rationale: ["fill remaining decision budget"],
      });
      selectedNumbers.add(pr.number);
      expectedDecisions += 1;
      laneTotals[lane] += 1;
    }
  }

  const expectedClusterDecisions = selected
    .filter((item) => item.lane === "cluster")
    .reduce((sum, item) => sum + item.decisionGain, 0);
  const expectedSingleDecisions = Math.max(0, expectedDecisions - expectedClusterDecisions);
  const decisionGainRatio = selected.length === 0 ? 0 : expectedDecisions / selected.length;

  return {
    mode,
    targetDecisions,
    expectedDecisions,
    expectedReviews: selected.length,
    expectedClusterDecisions,
    expectedSingleDecisions,
    decisionGainRatio,
    laneTotals,
    selected,
  };
}

export function applyPolicyFlagsToPlan(
  repo: string,
  analysis: AnalysisResult,
  plan: DailyPlan,
  outputDir: string,
  useCacheOnly: boolean,
): DailyPlan {
  const prByNumber = new Map(analysis.pullRequests.map((pr) => [pr.number, pr]));
  const neededNumbers = new Set(plan.selected.map((item) => item.representativeNumber));
  const diffMap = hydrateDiffDataForPrNumbers(repo, neededNumbers, outputDir, useCacheOnly);

  const selected = plan.selected.map((item) => {
    const pr = prByNumber.get(item.representativeNumber);
    if (!pr) {
      return { ...item, policyFlags: [] as PolicyFlag[] };
    }
    const diffData = diffMap.get(item.representativeNumber);
    const policyFlags = detectPolicyFlags({
      title: pr.title,
      body: pr.body,
      files: diffData?.files ?? [],
    });
    return { ...item, policyFlags };
  });

  return {
    ...plan,
    selected,
  };
}

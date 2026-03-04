import { buildClusters } from "./clustering.ts";
import type { AnalysisResult, OpenPullRequest } from "./types.ts";

export function analyzePullRequests(
  repo: string,
  openPullRequests: OpenPullRequest[],
  nowMs = Date.now(),
): AnalysisResult {
  const { pullRequests, clusters } = buildClusters(openPullRequests, nowMs);
  const topAuthors = new Map<string, number>();
  let likelyAutomationCount = 0;
  let highRiskCount = 0;
  let mediumRiskCount = 0;
  let lowRiskCount = 0;
  let draftCount = 0;

  for (const pr of pullRequests) {
    topAuthors.set(pr.author, (topAuthors.get(pr.author) ?? 0) + 1);
    if (pr.draft) {
      draftCount++;
    }
    if (pr.likelyAutomation) {
      likelyAutomationCount++;
    }
    if (pr.risk === "high") {
      highRiskCount++;
    } else if (pr.risk === "medium") {
      mediumRiskCount++;
    } else {
      lowRiskCount++;
    }
  }

  const sortedAuthors = [...topAuthors.entries()]
    .map(([author, openCount]) => ({ author, openCount }))
    .sort((left, right) => right.openCount - left.openCount)
    .slice(0, 20);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    repo,
    totalOpen: pullRequests.length,
    draftCount,
    readyCount: pullRequests.length - draftCount,
    likelyAutomationCount,
    highRiskCount,
    mediumRiskCount,
    lowRiskCount,
    uniqueAuthors: topAuthors.size,
    topAuthors: sortedAuthors,
    clusters,
    pullRequests,
  };
}

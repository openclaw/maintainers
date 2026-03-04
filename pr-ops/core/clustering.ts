import {
  AUTOMATION_RE,
  COMMIT_PREFIX_RE,
  HIGH_RISK_RE_LIST,
  MEDIUM_RISK_RE_LIST,
  NON_ALNUM_RE,
  PR_REFERENCE_RE,
  RECENT_WINDOW_MS,
  SPACE_RE,
  STOP_WORDS,
} from "./constants.ts";
import { hydrateDiffDataForPrNumbers } from "../github/client.ts";
import type {
  Cluster,
  ClusterBuildResult,
  ClusterConfidence,
  ClusterRefinement,
  OpenPullRequest,
  PullRequestDiffData,
  PullRequestFileDetail,
  RiskLevel,
} from "./types.ts";

export function normalizeTitleForClustering(title: string): string {
  return title
    .toLowerCase()
    .replace(PR_REFERENCE_RE, " ")
    .replace(COMMIT_PREFIX_RE, "")
    .replace(NON_ALNUM_RE, " ")
    .replace(SPACE_RE, " ")
    .trim();
}

function extractPrefix(title: string): string {
  const lower = title.toLowerCase().trim();
  const scopeMatch = lower.match(/^([a-z0-9_-]+(?:\([^)]+\))?):/);
  if (scopeMatch?.[1]) {
    return scopeMatch[1];
  }
  const plain = lower.split(/[\s:()]/)[0] || "unknown";
  return plain;
}

function tokenize(normalizedTitle: string): string[] {
  return normalizedTitle
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !/^\d+$/.test(token));
}

function buildCoreTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const core: string[] = [];
  for (const token of tokens) {
    if (token.length < 4 || STOP_WORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    core.push(token);
  }
  return core;
}

function isLikelyAutomation(title: string, author: string): boolean {
  return AUTOMATION_RE.test(title) || author.endsWith("[bot]");
}

function detectRisk(title: string, body: string): RiskLevel {
  const haystack = `${title}\n${body}`;
  for (const re of HIGH_RISK_RE_LIST) {
    if (re.test(haystack)) {
      return "high";
    }
  }
  for (const re of MEDIUM_RISK_RE_LIST) {
    if (re.test(haystack)) {
      return "medium";
    }
  }
  return "low";
}

function estimateEffort(pr: OpenPullRequest, risk: RiskLevel, likelyAutomation: boolean): number {
  let effort = 1;
  if (risk === "medium") {
    effort += 1;
  } else if (risk === "high") {
    effort += 2;
  }
  if (pr.body.length > 1200) {
    effort += 1;
  }
  if (pr.title.length > 100) {
    effort += 1;
  }
  if (pr.draft) {
    effort += 2;
  }
  if (!likelyAutomation && pr.authorAssociation === "NONE") {
    effort += 1;
  }
  if (likelyAutomation) {
    effort = Math.max(1, effort - 1);
  }
  return Math.min(effort, 5);
}

function tokenJaccard(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection++;
    }
  }
  const union = leftSet.size + rightSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function sharedTokenCount(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  let count = 0;
  for (const token of new Set(left)) {
    if (rightSet.has(token)) {
      count++;
    }
  }
  return count;
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    if (this.parent[index] === index) {
      return index;
    }
    this.parent[index] = this.find(this.parent[index]);
    return this.parent[index];
  }

  union(left: number, right: number) {
    const rootLeft = this.find(left);
    const rootRight = this.find(right);
    if (rootLeft !== rootRight) {
      this.parent[rootRight] = rootLeft;
    }
  }
}

export function buildClusters(
  openPullRequests: OpenPullRequest[],
  nowMs = Date.now(),
): ClusterBuildResult {
  const authorOpenCounts = new Map<string, number>();
  const authorRecentOpenCounts = new Map<string, number>();

  for (const pr of openPullRequests) {
    authorOpenCounts.set(pr.author, (authorOpenCounts.get(pr.author) ?? 0) + 1);
    const createdMs = Date.parse(pr.createdAt);
    if (Number.isFinite(createdMs) && nowMs - createdMs <= RECENT_WINDOW_MS) {
      authorRecentOpenCounts.set(pr.author, (authorRecentOpenCounts.get(pr.author) ?? 0) + 1);
    }
  }

  const pullRequests = openPullRequests.map((pr) => {
    const normalizedTitle = normalizeTitleForClustering(pr.title);
    const tokens = tokenize(normalizedTitle);
    const coreTokens = buildCoreTokens(tokens);
    const prefix = extractPrefix(pr.title);
    const likelyAutomation = isLikelyAutomation(pr.title, pr.author);
    const risk = detectRisk(pr.title, pr.body);
    const effort = estimateEffort(pr, risk, likelyAutomation);
    const createdMs = Date.parse(pr.createdAt);
    const updatedMs = Date.parse(pr.updatedAt);
    const ageHours = Number.isFinite(createdMs) ? (nowMs - createdMs) / (60 * 60 * 1000) : 0;

    return {
      ...pr,
      normalizedTitle,
      tokens,
      coreTokens,
      prefix,
      likelyAutomation,
      risk,
      effort,
      ageHours,
      createdMs: Number.isFinite(createdMs) ? createdMs : 0,
      updatedMs: Number.isFinite(updatedMs) ? updatedMs : 0,
      authorOpenCount: authorOpenCounts.get(pr.author) ?? 0,
      authorRecentOpenCount: authorRecentOpenCounts.get(pr.author) ?? 0,
      clusterId: null,
      clusterSize: 1,
    };
  });

  const uf = new UnionFind(pullRequests.length);
  const exactTitleMap = new Map<string, number[]>();
  pullRequests.forEach((pr, index) => {
    const list = exactTitleMap.get(pr.normalizedTitle);
    if (list) {
      list.push(index);
    } else {
      exactTitleMap.set(pr.normalizedTitle, [index]);
    }
  });

  for (const group of exactTitleMap.values()) {
    if (group.length < 2) {
      continue;
    }
    for (let index = 1; index < group.length; index++) {
      uf.union(group[0], group[index]);
    }
  }

  const nearBucketMap = new Map<string, number[]>();
  pullRequests.forEach((pr, index) => {
    if (pr.coreTokens.length < 2) {
      return;
    }
    const anchorTokens = [...pr.coreTokens]
      .sort((left, right) => right.length - left.length || left.localeCompare(right))
      .slice(0, 2);
    if (anchorTokens.length < 2) {
      return;
    }
    const key = `${pr.prefix}|${anchorTokens.join("|")}`;
    const bucket = nearBucketMap.get(key);
    if (bucket) {
      bucket.push(index);
    } else {
      nearBucketMap.set(key, [index]);
    }
  });

  for (const bucket of nearBucketMap.values()) {
    if (bucket.length < 2) {
      continue;
    }
    // Cap broad buckets to avoid noisy pairwise unions on generic titles.
    if (bucket.length > 40) {
      continue;
    }
    for (let left = 0; left < bucket.length - 1; left++) {
      for (let right = left + 1; right < bucket.length; right++) {
        const leftPr = pullRequests[bucket[left]];
        const rightPr = pullRequests[bucket[right]];
        const jaccard = tokenJaccard(leftPr.coreTokens, rightPr.coreTokens);
        const shared = sharedTokenCount(leftPr.coreTokens, rightPr.coreTokens);
        const closeInTime =
          Math.abs(leftPr.createdMs - rightPr.createdMs) <= 2 * 24 * 60 * 60 * 1000;
        const sameAuthor = leftPr.author === rightPr.author;
        if (shared >= 2 && (jaccard >= 0.72 || (jaccard >= 0.58 && (sameAuthor || closeInTime)))) {
          uf.union(bucket[left], bucket[right]);
        }
      }
    }
  }

  const grouped = new Map<number, number[]>();
  for (let index = 0; index < pullRequests.length; index++) {
    const root = uf.find(index);
    const list = grouped.get(root);
    if (list) {
      list.push(index);
    } else {
      grouped.set(root, [index]);
    }
  }

  let clusterIndex = 1;
  const clusters: Cluster[] = [];

  for (const indexes of grouped.values()) {
    if (indexes.length < 2) {
      continue;
    }
    const members = indexes.map((index) => pullRequests[index]);
    const exact = members.every((item) => item.normalizedTitle === members[0]?.normalizedTitle);
    const orderedByCreated = [...members].sort((left, right) => {
      if (left.createdMs !== right.createdMs) {
        return left.createdMs - right.createdMs;
      }
      return left.number - right.number;
    });
    const origin = orderedByCreated[0];

    const clusterId = `cluster-${clusterIndex++}`;
    const memberNumbers = orderedByCreated.map((member) => member.number);
    clusters.push({
      id: clusterId,
      reason: exact ? "exact_title" : "near_title",
      originNumber: origin.number,
      representativeNumber: origin.number,
      memberNumbers,
    });

    for (const member of members) {
      member.clusterId = clusterId;
      member.clusterSize = members.length;
    }
  }

  clusters.sort((left, right) => {
    if (right.memberNumbers.length !== left.memberNumbers.length) {
      return right.memberNumbers.length - left.memberNumbers.length;
    }
    return right.representativeNumber - left.representativeNumber;
  });

  return { pullRequests, clusters };
}

function normalizeFilePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .toLowerCase();
}

function coarsePathKey(path: string): string {
  const normalized = normalizeFilePath(path);
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return normalized;
  }
  if (parts.length === 1) {
    return parts[0] ?? normalized;
  }
  return `${parts[0]}/${parts[1]}`;
}

function setJaccard(leftValues: string[], rightValues: string[]): number {
  const left = new Set(leftValues);
  const right = new Set(rightValues);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection++;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function ratioSimilarity(left: number, right: number): number {
  const l = Math.max(0, left);
  const r = Math.max(0, right);
  if (l === 0 && r === 0) {
    return 1;
  }
  if (l === 0 || r === 0) {
    return 0;
  }
  const min = Math.min(l, r);
  const max = Math.max(l, r);
  return max === 0 ? 0 : min / max;
}

function buildDetailMap(details: PullRequestFileDetail[]): Map<string, PullRequestFileDetail> {
  const map = new Map<string, PullRequestFileDetail>();
  for (const detail of details) {
    map.set(normalizeFilePath(detail.path), detail);
  }
  return map;
}

function downgradeConfidence(confidence: ClusterConfidence): ClusterConfidence {
  if (confidence === "high") {
    return "medium";
  }
  if (confidence === "medium") {
    return "low";
  }
  return confidence;
}

function scoreClusterSimilarity(
  anchor: PullRequestDiffData,
  other: PullRequestDiffData,
): { similarity: number; exact: number; coarse: number; stats: number; totals: number } {
  const leftExact = anchor.files.map(normalizeFilePath);
  const rightExact = other.files.map(normalizeFilePath);
  const exact = setJaccard(leftExact, rightExact);

  const leftCoarse = anchor.files.map(coarsePathKey);
  const rightCoarse = other.files.map(coarsePathKey);
  const coarse = setJaccard(leftCoarse, rightCoarse);

  const anchorDetailMap = buildDetailMap(anchor.details);
  const otherDetailMap = buildDetailMap(other.details);
  let sharedScoreSum = 0;
  let sharedCount = 0;

  for (const [path, anchorDetail] of anchorDetailMap) {
    const otherDetail = otherDetailMap.get(path);
    if (!otherDetail) {
      continue;
    }
    const addRatio = ratioSimilarity(anchorDetail.additions, otherDetail.additions);
    const delRatio = ratioSimilarity(anchorDetail.deletions, otherDetail.deletions);
    const changeRatio = ratioSimilarity(anchorDetail.changes, otherDetail.changes);
    const statusScore = anchorDetail.status === otherDetail.status ? 1 : 0;
    const perFileScore = addRatio * 0.35 + delRatio * 0.35 + changeRatio * 0.2 + statusScore * 0.1;
    sharedScoreSum += perFileScore;
    sharedCount++;
  }
  const stats = sharedCount === 0 ? 0 : sharedScoreSum / sharedCount;
  const totals =
    ratioSimilarity(anchor.totalAdditions, other.totalAdditions) * 0.45 +
    ratioSimilarity(anchor.totalDeletions, other.totalDeletions) * 0.45 +
    ratioSimilarity(anchor.totalChanges, other.totalChanges) * 0.1;

  const similarity = exact * 0.45 + coarse * 0.15 + stats * 0.25 + totals * 0.15;
  return { similarity, exact, coarse, stats, totals };
}

function scoreClusterConfidence(
  cluster: Cluster,
  fileMap: Map<number, PullRequestDiffData>,
): ClusterRefinement {
  const memberCount = cluster.memberNumbers.length;
  let anchorNumber = cluster.originNumber;
  let anchorDiff = fileMap.get(anchorNumber);
  let originMissing = false;

  if (!anchorDiff || anchorDiff.files.length === 0) {
    originMissing = true;
    anchorNumber =
      cluster.memberNumbers.find((number) => {
        const data = fileMap.get(number);
        return Boolean(data && data.files.length > 0);
      }) ?? cluster.originNumber;
    anchorDiff = fileMap.get(anchorNumber);
  }

  if (!anchorDiff || anchorDiff.files.length === 0 || memberCount < 2) {
    return {
      clusterId: cluster.id,
      confidence: "unknown",
      anchorNumber: null,
      comparedMembers: 0,
      memberCount,
      coverage: 0,
      averageSimilarity: null,
      minimumSimilarity: null,
      representativeNumber: cluster.representativeNumber,
    };
  }

  const comparisons: number[] = [];
  for (const number of cluster.memberNumbers) {
    if (number === anchorNumber) {
      continue;
    }
    const diffData = fileMap.get(number);
    if (!diffData || diffData.files.length === 0) {
      continue;
    }
    const { similarity } = scoreClusterSimilarity(anchorDiff, diffData);
    comparisons.push(similarity);
  }

  const comparedMembers = comparisons.length;
  const targetComparisons = Math.max(1, memberCount - 1);
  const coverage = comparedMembers / targetComparisons;

  if (comparedMembers === 0) {
    return {
      clusterId: cluster.id,
      confidence: "unknown",
      anchorNumber,
      comparedMembers: 0,
      memberCount,
      coverage,
      averageSimilarity: null,
      minimumSimilarity: null,
      representativeNumber: cluster.representativeNumber,
    };
  }

  const averageSimilarity = comparisons.reduce((sum, value) => sum + value, 0) / comparedMembers;
  const minimumSimilarity = Math.min(...comparisons);

  let confidence: ClusterConfidence;
  if (averageSimilarity >= 0.74 && minimumSimilarity >= 0.45) {
    confidence = "high";
  } else if (averageSimilarity >= 0.56 && minimumSimilarity >= 0.2) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  if (coverage < 0.4) {
    confidence = "unknown";
  } else if (coverage < 0.75) {
    confidence = downgradeConfidence(confidence);
  }
  if (originMissing) {
    confidence = downgradeConfidence(confidence);
  }

  return {
    clusterId: cluster.id,
    confidence,
    anchorNumber,
    comparedMembers,
    memberCount,
    coverage,
    averageSimilarity,
    minimumSimilarity,
    representativeNumber: cluster.representativeNumber,
  };
}

export function computeClusterRefinements(
  repo: string,
  clusters: Cluster[],
  outputDir: string,
  useCacheOnly: boolean,
): ClusterRefinement[] {
  const neededNumbers = new Set<number>();
  for (const cluster of clusters) {
    for (const number of cluster.memberNumbers) {
      neededNumbers.add(number);
    }
  }

  const fileMap = hydrateDiffDataForPrNumbers(repo, neededNumbers, outputDir, useCacheOnly);
  return clusters.map((cluster) => scoreClusterConfidence(cluster, fileMap));
}

export type RiskLevel = "low" | "medium" | "high";
export type Lane = "cluster" | "fast" | "deep";
export type ClusterConfidence = "high" | "medium" | "low" | "unknown";
export type PlanMode = "balanced" | "dedupe-first";

export type PolicyFlag =
  | "vendor_lockin_default_path"
  | "auto_enable_vendor_tools"
  | "default_profile_shift"
  | "vendor_core_not_optional";

export type OpenPullRequest = {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  url: string;
  author: string;
  authorAssociation: string;
  headRepo: string;
  headRef: string;
  baseRef: string;
};

export type ParsedCliOptions = {
  repo: string;
  outputDir: string;
  targetDecisions: number;
  useCache: boolean;
  live: boolean;
  mode: PlanMode;
};

export type DerivedPullRequest = OpenPullRequest & {
  normalizedTitle: string;
  tokens: string[];
  coreTokens: string[];
  prefix: string;
  likelyAutomation: boolean;
  risk: RiskLevel;
  effort: number;
  ageHours: number;
  createdMs: number;
  updatedMs: number;
  authorOpenCount: number;
  authorRecentOpenCount: number;
  clusterId: string | null;
  clusterSize: number;
};

export type Cluster = {
  id: string;
  reason: "exact_title" | "near_title";
  originNumber: number;
  representativeNumber: number;
  memberNumbers: number[];
};

export type AnalysisResult = {
  generatedAt: string;
  repo: string;
  totalOpen: number;
  draftCount: number;
  readyCount: number;
  likelyAutomationCount: number;
  highRiskCount: number;
  mediumRiskCount: number;
  lowRiskCount: number;
  uniqueAuthors: number;
  topAuthors: Array<{ author: string; openCount: number }>;
  clusters: Cluster[];
  pullRequests: DerivedPullRequest[];
};

export type PlanItem = {
  lane: Lane;
  representativeNumber: number;
  originNumber: number | null;
  representativeUrl: string;
  title: string;
  author: string;
  risk: RiskLevel;
  effort: number;
  decisionGain: number;
  clusterId: string | null;
  clusterMembers: number[];
  clusterConfidence: ClusterConfidence | null;
  clusterCoverage: number | null;
  policyFlags: PolicyFlag[];
  rationale: string[];
};

export type DailyPlan = {
  mode: PlanMode;
  targetDecisions: number;
  expectedDecisions: number;
  expectedReviews: number;
  expectedClusterDecisions: number;
  expectedSingleDecisions: number;
  decisionGainRatio: number;
  laneTotals: { cluster: number; fast: number; deep: number };
  selected: PlanItem[];
};

export type RawLinePullRequest = {
  number: number;
  title: string;
  body?: string | null;
  created_at: string;
  updated_at: string;
  draft?: boolean;
  html_url: string;
  author_association?: string;
  user?: { login?: string | null } | null;
  headRepo?: string;
  headRef?: string;
  baseRef?: string;
};

export type RawLinePullRequestFile = {
  filename?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  status?: string;
};

export type ClusterBuildResult = {
  pullRequests: DerivedPullRequest[];
  clusters: Cluster[];
};

export type PullRequestFileDetail = {
  path: string;
  additions: number;
  deletions: number;
  changes: number;
  status: string;
};

export type PullRequestDiffData = {
  files: string[];
  details: PullRequestFileDetail[];
  totalAdditions: number;
  totalDeletions: number;
  totalChanges: number;
};

export type ClusterRefinement = {
  clusterId: string;
  confidence: ClusterConfidence;
  anchorNumber: number | null;
  comparedMembers: number;
  memberCount: number;
  coverage: number;
  averageSimilarity: number | null;
  minimumSimilarity: number | null;
  representativeNumber: number;
};

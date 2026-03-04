export const DEFAULT_REPO = "openclaw/openclaw";
export const DEFAULT_TARGET_DECISIONS = 10;
export const DEFAULT_OUTPUT_DIR = ".local/pr-plan";
export const GH_MAX_BUFFER = 128 * 1024 * 1024;
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const COMMIT_PREFIX_RE =
  /^(fix|feat|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)]+\))?!?:\s*/i;
export const PR_REFERENCE_RE = /(?:\(\s*#\d+\s*\)|#\d+)/g;
export const SPACE_RE = /\s+/g;
export const NON_ALNUM_RE = /[^a-z0-9\s]/g;
export const AUTOMATION_RE =
  /\b(automated|auto[- ]?update|dependabot|sync|bump|deps|dependency update|generated)\b/i;

export const HIGH_RISK_RE_LIST = [
  /\b(security|vulnerability|cve|ghsa)\b/i,
  /\b(auth|oauth|token|credential|password|permission|allowlist|access control)\b/i,
  /\b(migration|schema|database|sqlite|postgres|mysql)\b/i,
  /\b(release|publish|signing|notary|appcast)\b/i,
];

export const MEDIUM_RISK_RE_LIST = [
  /\b(routing|gateway|ingress|egress)\b/i,
  /\b(protocol|provider|session|state|infra|docker|ci)\b/i,
  /\b(refactor|rewrite|overhaul)\b/i,
];

export const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "via",
  "use",
  "using",
  "update",
  "fix",
  "feat",
  "chore",
  "docs",
  "refactor",
  "test",
  "add",
  "remove",
  "support",
  "improve",
]);

export const VENDOR_HINT_RE =
  /\b(firecrawl|tavily|brave|serpapi|exa|searxng|serper|browserbase)\b/i;
export const ONBOARDING_TEXT_RE = /\b(onboard|onboarding|setup wizard|setup flow|setup)\b/i;
export const TOOL_AUTO_ENABLE_RE =
  /\b(alsoallow|auto[- ]?allow|auto[- ]?enable|auto-enable|auto allow|tool access)\b/i;
export const DEFAULT_SHIFT_TEXT_RE =
  /\b(default profile|default browser|default driver|promote.*default|fallback default)\b/i;
export const OPTIONAL_TEXT_RE = /\b(opt[- ]?in|optional|extension|plugin)\b/i;

export const ONBOARDING_PATH_RE = /^src\/(commands\/onboard-|wizard\/onboarding)/;
export const BROWSER_DEFAULT_PATH_RE =
  /^src\/browser\/(config|profiles-service|server-context\.selection|server-context)/;
export const TOOL_CATALOG_PATH_RE = /^src\/agents\/(openclaw-tools\.ts|tools\/)/;
export const CORE_RUNTIME_PATH_RE = /^src\/(agents|browser|commands|wizard|config)\//;
export const DEFAULT_POLICY_PATH_RE =
  /^src\/(commands\/onboard-|wizard\/onboarding|browser\/(config|profiles-service|server-context\.selection)|agents\/openclaw-tools\.ts)/;

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { GH_MAX_BUFFER } from "../core/constants.ts";
import type {
  OpenPullRequest,
  PullRequestDiffData,
  PullRequestFileDetail,
  RawLinePullRequest,
  RawLinePullRequestFile,
} from "../core/types.ts";

const OPEN_PULLS_PAGE_SIZE = 100;

function runGhApi(args: string[]): string {
  return execFileSync("gh", ["api", ...args], {
    encoding: "utf8",
    maxBuffer: GH_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export type PullRequestLiveStatus = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  url: string;
  title: string;
};

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
    } catch (error) {
      throw new Error(`Failed to parse JSON line ${index + 1}: ${(error as Error).message}`);
    }
  }
  return rows;
}

function toOpenPullRequest(row: RawLinePullRequest): OpenPullRequest {
  return {
    number: row.number,
    title: row.title,
    body: row.body ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    draft: Boolean(row.draft),
    url: row.html_url,
    author: row.user?.login?.trim() || "unknown",
    authorAssociation: row.author_association ?? "NONE",
    headRepo: row.headRepo ?? "",
    headRef: row.headRef ?? "",
    baseRef: row.baseRef ?? "",
  };
}

function compareOpenPullRequestByUpdatedDesc(left: OpenPullRequest, right: OpenPullRequest): number {
  if (left.updatedAt === right.updatedAt) {
    return right.number - left.number;
  }
  return right.updatedAt.localeCompare(left.updatedAt);
}

function dedupeOpenPullRequestsByNumber(rows: OpenPullRequest[]): OpenPullRequest[] {
  const dedupedByNumber = new Map<number, OpenPullRequest>();
  for (const row of rows) {
    const existing = dedupedByNumber.get(row.number);
    if (!existing || row.updatedAt > existing.updatedAt) {
      dedupedByNumber.set(row.number, row);
    }
  }
  return [...dedupedByNumber.values()];
}

function shouldReplaceOpenPullRequest(existing: OpenPullRequest, candidate: OpenPullRequest): boolean {
  if (candidate.updatedAt !== existing.updatedAt) {
    return candidate.updatedAt > existing.updatedAt;
  }
  return (
    candidate.title !== existing.title ||
    candidate.body !== existing.body ||
    candidate.draft !== existing.draft ||
    candidate.author !== existing.author ||
    candidate.authorAssociation !== existing.authorAssociation ||
    candidate.headRepo !== existing.headRepo ||
    candidate.headRef !== existing.headRef ||
    candidate.baseRef !== existing.baseRef ||
    candidate.url !== existing.url
  );
}

function fetchOpenPullRequestsPage(repo: string, page: number): OpenPullRequest[] {
  const ghOutput = runGhApi([
    "-X",
    "GET",
    `repos/${repo}/pulls`,
    "-f",
    "state=open",
    "-f",
    `per_page=${OPEN_PULLS_PAGE_SIZE}`,
    "-f",
    "sort=updated",
    "-f",
    "direction=desc",
    "-f",
    `page=${page}`,
    "--jq",
    '.[] | {number,title,body,created_at,updated_at,draft,html_url,author_association,user:{login:.user.login},headRepo:(.head.repo.full_name // ""),headRef:(.head.ref // ""),baseRef:(.base.ref // "")}',
  ]);
  return dedupeOpenPullRequestsByNumber(
    parseJsonLines<RawLinePullRequest>(ghOutput).map(toOpenPullRequest),
  ).sort(compareOpenPullRequestByUpdatedDesc);
}

export function fetchOpenPullRequests(repo: string): OpenPullRequest[] {
  const ghOutput = runGhApi([
    "-X",
    "GET",
    `repos/${repo}/pulls`,
    "-f",
    "state=open",
    "-f",
    `per_page=${OPEN_PULLS_PAGE_SIZE}`,
    "-f",
    "sort=updated",
    "-f",
    "direction=desc",
    "--paginate",
    "--jq",
    '.[] | {number,title,body,created_at,updated_at,draft,html_url,author_association,user:{login:.user.login},headRepo:(.head.repo.full_name // ""),headRef:(.head.ref // ""),baseRef:(.base.ref // "")}',
  ]);

  return dedupeOpenPullRequestsByNumber(parseJsonLines<RawLinePullRequest>(ghOutput).map(toOpenPullRequest))
    .sort(compareOpenPullRequestByUpdatedDesc);
}

export type IncrementalOpenPullRequestMergeInput = {
  cachedOpenPullRequests: OpenPullRequest[];
  liveOpenPullRequestsAtOrAboveWatermark: OpenPullRequest[];
  watermark: string;
};

export type IncrementalOpenPullRequestMergeResult = {
  pullRequests: OpenPullRequest[];
  upsertedCount: number;
  removedClosedCount: number;
};

export function computeOpenPullRequestWatermark(cachedOpenPullRequests: OpenPullRequest[]): string | null {
  if (cachedOpenPullRequests.length === 0) {
    return null;
  }
  let latest = cachedOpenPullRequests[0]?.updatedAt ?? null;
  for (const current of cachedOpenPullRequests) {
    if (latest === null || current.updatedAt > latest) {
      latest = current.updatedAt;
    }
  }
  return latest;
}

export function mergeIncrementalOpenPullRequests(
  input: IncrementalOpenPullRequestMergeInput,
): IncrementalOpenPullRequestMergeResult {
  const { cachedOpenPullRequests, liveOpenPullRequestsAtOrAboveWatermark, watermark } = input;
  const mergedByNumber = new Map<number, OpenPullRequest>(
    cachedOpenPullRequests.map((pr) => [pr.number, pr]),
  );
  const liveNumbersAtOrAboveWatermark = new Set<number>();
  let upsertedCount = 0;

  for (const candidate of liveOpenPullRequestsAtOrAboveWatermark) {
    if (candidate.updatedAt < watermark) {
      continue;
    }
    liveNumbersAtOrAboveWatermark.add(candidate.number);
    const existing = mergedByNumber.get(candidate.number);
    if (!existing || shouldReplaceOpenPullRequest(existing, candidate)) {
      mergedByNumber.set(candidate.number, candidate);
      upsertedCount++;
    }
  }

  let removedClosedCount = 0;
  for (const cached of cachedOpenPullRequests) {
    if (cached.updatedAt >= watermark && !liveNumbersAtOrAboveWatermark.has(cached.number)) {
      if (mergedByNumber.delete(cached.number)) {
        removedClosedCount++;
      }
    }
  }

  return {
    pullRequests: [...mergedByNumber.values()].sort(compareOpenPullRequestByUpdatedDesc),
    upsertedCount,
    removedClosedCount,
  };
}

export type RefreshOpenPullRequestsFromCacheOptions = {
  onProgress?: (message: string) => void;
};

export type RefreshOpenPullRequestsFromCacheResult = {
  mode: "incremental" | "full";
  pullRequests: OpenPullRequest[];
  watermark: string | null;
  pagesFetched: number;
  fetchedRows: number;
  upsertedCount: number;
  removedClosedCount: number;
};

export function refreshOpenPullRequestsFromCache(
  repo: string,
  cachedOpenPullRequests: OpenPullRequest[],
  options: RefreshOpenPullRequestsFromCacheOptions = {},
): RefreshOpenPullRequestsFromCacheResult {
  const watermark = computeOpenPullRequestWatermark(cachedOpenPullRequests);
  if (!watermark || cachedOpenPullRequests.length === 0) {
    const pullRequests = fetchOpenPullRequests(repo);
    return {
      mode: "full",
      pullRequests,
      watermark: null,
      pagesFetched: 0,
      fetchedRows: pullRequests.length,
      upsertedCount: pullRequests.length,
      removedClosedCount: 0,
    };
  }

  let page = 1;
  let pagesFetched = 0;
  let fetchedRows = 0;
  const liveAtOrAboveWatermark: OpenPullRequest[] = [];

  while (true) {
    const pageRows = fetchOpenPullRequestsPage(repo, page);
    pagesFetched++;
    fetchedRows += pageRows.length;
    if (pageRows.length === 0) {
      break;
    }

    let hitOlderThanWatermark = false;
    for (const row of pageRows) {
      if (row.updatedAt < watermark) {
        hitOlderThanWatermark = true;
        break;
      }
      liveAtOrAboveWatermark.push(row);
    }

    if (hitOlderThanWatermark || pageRows.length < OPEN_PULLS_PAGE_SIZE) {
      break;
    }
    page++;
  }

  const mergeResult = mergeIncrementalOpenPullRequests({
    cachedOpenPullRequests,
    liveOpenPullRequestsAtOrAboveWatermark: dedupeOpenPullRequestsByNumber(liveAtOrAboveWatermark),
    watermark,
  });
  options.onProgress?.(
    [
      "Incremental refresh",
      `watermark=${watermark}`,
      `pages=${pagesFetched}`,
      `rows=${fetchedRows}`,
      `upserted=${mergeResult.upsertedCount}`,
      `removedClosed=${mergeResult.removedClosedCount}`,
    ].join(" | "),
  );

  return {
    mode: "incremental",
    pullRequests: mergeResult.pullRequests,
    watermark,
    pagesFetched,
    fetchedRows,
    upsertedCount: mergeResult.upsertedCount,
    removedClosedCount: mergeResult.removedClosedCount,
  };
}

export function fetchPullRequestLiveStatus(
  repo: string,
  prNumber: number,
): PullRequestLiveStatus | null {
  try {
    const output = runGhApi([
      "-X",
      "GET",
      `repos/${repo}/pulls/${prNumber}`,
      "--jq",
      "{number,state,merged,merged_at,html_url,title}",
    ]).trim();
    if (!output) {
      return null;
    }
    const raw = JSON.parse(output) as {
      number?: unknown;
      state?: unknown;
      merged?: unknown;
      merged_at?: unknown;
      html_url?: unknown;
      title?: unknown;
    };
    const number = Number(raw.number);
    const state = raw.state === "open" ? "open" : raw.state === "closed" ? "closed" : null;
    const merged = Boolean(raw.merged);
    const mergedAt =
      typeof raw.merged_at === "string" && raw.merged_at.length > 0 ? raw.merged_at : null;
    const url =
      typeof raw.html_url === "string"
        ? raw.html_url
        : `https://github.com/${repo}/pull/${prNumber}`;
    const title = typeof raw.title === "string" ? raw.title : "";
    if (!Number.isFinite(number) || number <= 0 || state === null) {
      return null;
    }
    return {
      number: Math.trunc(number),
      state,
      merged,
      mergedAt,
      url,
      title,
    };
  } catch {
    return null;
  }
}

export function writeJson(path: string, data: unknown) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function writeJsonLines(path: string, rows: unknown[]) {
  const payload = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  writeFileSync(path, payload, "utf8");
}

export function readCachedOpenPullRequests(path: string): OpenPullRequest[] {
  if (!existsSync(path)) {
    throw new Error(`Cache file not found: ${path}`);
  }
  return parseJsonLines<OpenPullRequest>(readFileSync(path, "utf8"));
}

function readPullRequestFilesCache(path: string): Record<string, PullRequestDiffData> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") {
      return {};
    }

    const cache: Record<string, PullRequestDiffData> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (Array.isArray(value)) {
        const files = value.filter((item): item is string => typeof item === "string");
        cache[key] = {
          files,
          details: files.map((path) => ({
            path,
            additions: 0,
            deletions: 0,
            changes: 0,
            status: "modified",
          })),
          totalAdditions: 0,
          totalDeletions: 0,
          totalChanges: 0,
        };
        continue;
      }

      if (value && typeof value === "object") {
        const files = Array.isArray((value as { files?: unknown }).files)
          ? ((value as { files: unknown[] }).files.filter(
              (item): item is string => typeof item === "string",
            ) as string[])
          : [];

        const details = Array.isArray((value as { details?: unknown }).details)
          ? ((value as { details: unknown[] }).details
              .map((item) => {
                if (!item || typeof item !== "object") {
                  return null;
                }
                const path = (item as { path?: unknown }).path;
                if (typeof path !== "string" || path.length === 0) {
                  return null;
                }
                const detail: PullRequestFileDetail = {
                  path,
                  additions: Number((item as { additions?: unknown }).additions ?? 0) || 0,
                  deletions: Number((item as { deletions?: unknown }).deletions ?? 0) || 0,
                  changes: Number((item as { changes?: unknown }).changes ?? 0) || 0,
                  status:
                    typeof (item as { status?: unknown }).status === "string"
                      ? ((item as { status: string }).status ?? "modified")
                      : "modified",
                };
                return detail;
              })
              .filter(
                (item): item is PullRequestFileDetail => item !== null,
              ) as PullRequestFileDetail[])
          : [];

        const normalizedFiles = files.length > 0 ? files : details.map((detail) => detail.path);
        cache[key] = {
          files: normalizedFiles,
          details,
          totalAdditions:
            Number((value as { totalAdditions?: unknown }).totalAdditions ?? 0) ||
            details.reduce((sum, detail) => sum + detail.additions, 0),
          totalDeletions:
            Number((value as { totalDeletions?: unknown }).totalDeletions ?? 0) ||
            details.reduce((sum, detail) => sum + detail.deletions, 0),
          totalChanges:
            Number((value as { totalChanges?: unknown }).totalChanges ?? 0) ||
            details.reduce((sum, detail) => sum + detail.changes, 0),
        };
      }
    }
    return cache;
  } catch {
    return {};
  }
}

function fetchPullRequestFiles(repo: string, prNumber: number): PullRequestDiffData | null {
  try {
    const output = runGhApi([
      "-X",
      "GET",
      `repos/${repo}/pulls/${prNumber}/files`,
      "-f",
      "per_page=100",
      "--paginate",
      "--jq",
      ".[] | {filename,additions,deletions,changes,status}",
    ]);
    const rows = parseJsonLines<RawLinePullRequestFile>(output);
    const details: PullRequestFileDetail[] = [];

    for (const row of rows) {
      const path = (row.filename ?? "").trim();
      if (path.length === 0) {
        continue;
      }
      details.push({
        path,
        additions: Number(row.additions ?? 0) || 0,
        deletions: Number(row.deletions ?? 0) || 0,
        changes: Number(row.changes ?? 0) || 0,
        status: row.status ?? "modified",
      });
    }

    const files = details.map((detail) => detail.path);
    return {
      files,
      details,
      totalAdditions: details.reduce((sum, detail) => sum + detail.additions, 0),
      totalDeletions: details.reduce((sum, detail) => sum + detail.deletions, 0),
      totalChanges: details.reduce((sum, detail) => sum + detail.changes, 0),
    };
  } catch {
    return null;
  }
}

export function hydrateDiffDataForPrNumbers(
  repo: string,
  prNumbers: Iterable<number>,
  outputDir: string,
  useCacheOnly: boolean,
): Map<number, PullRequestDiffData> {
  const cachePath = resolve(outputDir, "pr-files-cache.json");
  const cache = readPullRequestFilesCache(cachePath);
  let cacheDirty = false;
  const diffMap = new Map<number, PullRequestDiffData>();

  for (const number of prNumbers) {
    const cacheKey = String(number);
    const cached = cache[cacheKey];
    if (cached && cached.files.length > 0) {
      diffMap.set(number, cached);
      continue;
    }
    if (useCacheOnly) {
      continue;
    }
    const fetched = fetchPullRequestFiles(repo, number);
    if (fetched && fetched.files.length > 0) {
      cache[cacheKey] = fetched;
      diffMap.set(number, fetched);
      cacheDirty = true;
    }
  }

  if (cacheDirty) {
    writeJson(cachePath, cache);
  }

  return diffMap;
}

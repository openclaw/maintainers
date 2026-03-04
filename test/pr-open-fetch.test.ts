import { describe, expect, it } from "vitest";

import type { OpenPullRequest } from "../pr-ops/core/types.ts";
import {
  computeOpenPullRequestWatermark,
  mergeIncrementalOpenPullRequests,
} from "../pr-ops/github/client.ts";

function pr(
  number: number,
  updatedAt: string,
  overrides: Partial<OpenPullRequest> = {},
): OpenPullRequest {
  return {
    number,
    title: `PR ${number}`,
    body: "",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt,
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

describe("open pr incremental cache merge", () => {
  it("computes the latest watermark from cached PRs", () => {
    const watermark = computeOpenPullRequestWatermark([
      pr(10, "2026-03-01T01:00:00Z"),
      pr(11, "2026-03-03T09:00:00Z"),
      pr(12, "2026-03-02T05:00:00Z"),
    ]);
    expect(watermark).toBe("2026-03-03T09:00:00Z");
  });

  it("upserts changed PRs and adds new PRs from the live window", () => {
    const result = mergeIncrementalOpenPullRequests({
      cachedOpenPullRequests: [
        pr(10, "2026-03-03T09:00:00Z", { title: "old title" }),
        pr(11, "2026-03-02T08:00:00Z"),
      ],
      liveOpenPullRequestsAtOrAboveWatermark: [
        pr(10, "2026-03-03T10:00:00Z", { title: "new title" }),
        pr(12, "2026-03-03T10:00:00Z"),
      ],
      watermark: "2026-03-03T09:00:00Z",
    });

    expect(result.upsertedCount).toBe(2);
    expect(result.removedClosedCount).toBe(0);
    expect(result.pullRequests.map((item) => item.number)).toEqual([12, 10, 11]);
    expect(result.pullRequests.find((item) => item.number === 10)?.title).toBe("new title");
  });

  it("removes cached PRs at/above watermark that disappeared from live open results", () => {
    const result = mergeIncrementalOpenPullRequests({
      cachedOpenPullRequests: [
        pr(20, "2026-03-03T09:00:00Z"),
        pr(21, "2026-03-03T09:00:00Z"),
        pr(22, "2026-03-01T01:00:00Z"),
      ],
      liveOpenPullRequestsAtOrAboveWatermark: [pr(20, "2026-03-03T09:00:00Z")],
      watermark: "2026-03-03T09:00:00Z",
    });

    expect(result.upsertedCount).toBe(0);
    expect(result.removedClosedCount).toBe(1);
    expect(result.pullRequests.map((item) => item.number)).toEqual([20, 22]);
  });
});

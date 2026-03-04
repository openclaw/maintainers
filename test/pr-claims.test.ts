import { describe, expect, it } from "vitest";

import {
  buildActiveClaimsByPrNumber,
  computeClaimExpiry,
  resolveClaimOwner,
  summarizeActiveClaimsByOwner,
  type ClaimRecord,
} from "../pr-ops/state/claims.ts";

describe("claim state helpers", () => {
  it("keeps only active, non-released claims", () => {
    const now = new Date("2026-03-03T12:00:00.000Z");
    const records: ClaimRecord[] = [
      {
        id: "1",
        claimedAt: "2026-03-03T10:00:00.000Z",
        owner: "codex-a",
        prNumber: 100,
        action: "claim",
        expiresAt: "2026-03-03T14:00:00.000Z",
        note: "",
      },
      {
        id: "2",
        claimedAt: "2026-03-03T10:30:00.000Z",
        owner: "codex-b",
        prNumber: 101,
        action: "claim",
        expiresAt: "2026-03-03T11:00:00.000Z",
        note: "",
      },
      {
        id: "3",
        claimedAt: "2026-03-03T11:00:00.000Z",
        owner: "codex-c",
        prNumber: 102,
        action: "claim",
        expiresAt: "2026-03-03T13:00:00.000Z",
        note: "",
      },
      {
        id: "4",
        claimedAt: "2026-03-03T11:30:00.000Z",
        owner: "codex-c",
        prNumber: 102,
        action: "release",
        expiresAt: null,
        note: "",
      },
    ];

    const active = buildActiveClaimsByPrNumber(records, now);
    expect([...active.keys()].sort((left, right) => left - right)).toEqual([100]);
    expect(active.get(100)?.owner).toBe("codex-a");
  });

  it("summarizes active claims per owner", () => {
    const now = new Date("2026-03-03T12:00:00.000Z");
    const active = buildActiveClaimsByPrNumber(
      [
        {
          id: "1",
          claimedAt: "2026-03-03T10:00:00.000Z",
          owner: "codex-b",
          prNumber: 100,
          action: "claim",
          expiresAt: "2026-03-03T14:00:00.000Z",
          note: "",
        },
        {
          id: "2",
          claimedAt: "2026-03-03T10:05:00.000Z",
          owner: "codex-a",
          prNumber: 101,
          action: "claim",
          expiresAt: "2026-03-03T14:00:00.000Z",
          note: "",
        },
        {
          id: "3",
          claimedAt: "2026-03-03T10:10:00.000Z",
          owner: "codex-a",
          prNumber: 102,
          action: "claim",
          expiresAt: "2026-03-03T14:00:00.000Z",
          note: "",
        },
      ],
      now,
    );
    expect(summarizeActiveClaimsByOwner(active)).toEqual([
      { owner: "codex-a", count: 2 },
      { owner: "codex-b", count: 1 },
    ]);
  });

  it("computes deterministic claim expiry from ttl", () => {
    const now = new Date("2026-03-03T12:00:00.000Z");
    expect(computeClaimExpiry(now, 90)).toBe("2026-03-03T13:30:00.000Z");
  });

  it("prefers explicit owner over environment fallback", () => {
    const prevEnvOwner = process.env.PR_OPS_OWNER;
    const prevUser = process.env.USER;
    try {
      process.env.PR_OPS_OWNER = "env-owner";
      process.env.USER = "env-user";
      expect(resolveClaimOwner("explicit-owner")).toBe("explicit-owner");
      expect(resolveClaimOwner(" ")).toBe("env-owner");
      delete process.env.PR_OPS_OWNER;
      expect(resolveClaimOwner(null)).toBe("env-user");
    } finally {
      if (typeof prevEnvOwner === "string") {
        process.env.PR_OPS_OWNER = prevEnvOwner;
      } else {
        delete process.env.PR_OPS_OWNER;
      }
      if (typeof prevUser === "string") {
        process.env.USER = prevUser;
      } else {
        delete process.env.USER;
      }
    }
  });
});

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_CLAIMS_PATH = "pr-ops/state/claims.jsonl";
export const DEFAULT_CLAIM_TTL_MINUTES = 120;

export const CLAIM_ACTIONS = ["claim", "release"] as const;
export type ClaimAction = (typeof CLAIM_ACTIONS)[number];

export type ClaimRecord = {
  id: string;
  claimedAt: string;
  owner: string;
  prNumber: number;
  action: ClaimAction;
  expiresAt: string | null;
  note: string;
};

export type ActiveClaim = {
  id: string;
  claimedAt: string;
  owner: string;
  prNumber: number;
  expiresAt: string | null;
  note: string;
};

function parseJsonLines<T>(contents: string): T[] {
  const rows: T[] = [];
  const lines = contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // Ignore malformed historical lines to keep workflow robust.
    }
  }
  return rows;
}

function normalizeClaimAction(value: unknown): ClaimAction | null {
  if (typeof value !== "string") {
    return null;
  }
  return CLAIM_ACTIONS.includes(value as ClaimAction) ? (value as ClaimAction) : null;
}

function normalizeClaimRecord(raw: unknown): ClaimRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const action = normalizeClaimAction((raw as { action?: unknown }).action);
  if (!action) {
    return null;
  }

  const prNumber = Number((raw as { prNumber?: unknown }).prNumber);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return null;
  }

  const idRaw = (raw as { id?: unknown }).id;
  const claimedAtRaw = (raw as { claimedAt?: unknown }).claimedAt;
  const ownerRaw = (raw as { owner?: unknown }).owner;
  const expiresAtRaw = (raw as { expiresAt?: unknown }).expiresAt;
  const noteRaw = (raw as { note?: unknown }).note;

  return {
    id: typeof idRaw === "string" && idRaw.length > 0 ? idRaw : "unknown",
    claimedAt:
      typeof claimedAtRaw === "string" && claimedAtRaw.length > 0
        ? claimedAtRaw
        : new Date(0).toISOString(),
    owner: typeof ownerRaw === "string" ? ownerRaw.trim() : "",
    prNumber: Math.trunc(prNumber),
    action,
    expiresAt: typeof expiresAtRaw === "string" && expiresAtRaw.length > 0 ? expiresAtRaw : null,
    note: typeof noteRaw === "string" ? noteRaw : "",
  };
}

function parseIsoMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function computeClaimExpiry(now: Date, ttlMinutes: number): string {
  return new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();
}

export function resolveClaimOwner(explicitOwner: string | null): string | null {
  const candidates = [explicitOwner, process.env.PR_OPS_OWNER, process.env.USER];
  for (const value of candidates) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

export function readClaimLog(path: string): ClaimRecord[] {
  if (!existsSync(path)) {
    return [];
  }
  const rows = parseJsonLines<unknown>(readFileSync(path, "utf8"));
  return rows
    .map((row) => normalizeClaimRecord(row))
    .filter((row): row is ClaimRecord => row !== null && row.owner.length > 0);
}

export function appendClaimRecord(path: string, record: ClaimRecord) {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

export function buildActiveClaimsByPrNumber(
  records: ClaimRecord[],
  now = new Date(),
): Map<number, ActiveClaim> {
  const active = new Map<number, ActiveClaim>();
  for (const record of records) {
    if (record.action === "release") {
      active.delete(record.prNumber);
      continue;
    }
    active.set(record.prNumber, {
      id: record.id,
      claimedAt: record.claimedAt,
      owner: record.owner,
      prNumber: record.prNumber,
      expiresAt: record.expiresAt,
      note: record.note,
    });
  }

  const nowMs = now.getTime();
  for (const [prNumber, claim] of active.entries()) {
    const expiresAtMs = parseIsoMs(claim.expiresAt);
    if (expiresAtMs !== null && expiresAtMs <= nowMs) {
      active.delete(prNumber);
    }
  }
  return active;
}

export function summarizeActiveClaimsByOwner(
  claims: Map<number, ActiveClaim>,
): Array<{ owner: string; count: number }> {
  const counts = new Map<string, number>();
  for (const claim of claims.values()) {
    counts.set(claim.owner, (counts.get(claim.owner) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([owner, count]) => ({ owner, count }))
    .sort((left, right) => right.count - left.count || left.owner.localeCompare(right.owner));
}

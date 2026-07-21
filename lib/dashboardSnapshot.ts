import { createHash } from "node:crypto";
import {
  buildDashboardHref,
  type DashboardQuery,
} from "@/lib/dashboardQuery";

export const DASHBOARD_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
export const DASHBOARD_SNAPSHOT_INSERT_CHUNK_SIZE = 1_000;

export interface DashboardSnapshotSourceRow {
  id: string;
  date: Date;
}

export interface DashboardSnapshotMember {
  position: number;
  showId: string;
  sortDate: Date;
}

export type DashboardSnapshotAccessStatus = "ok" | "invalid" | "expired";

export function dashboardSnapshotAccessStatus(
  snapshot: {
    ownerKey: string;
    queryKey: string;
    total: number;
    expiresAt: Date;
  } | null,
  query: DashboardQuery,
  ownerKey: string,
  position: number,
  now: Date
): DashboardSnapshotAccessStatus {
  if (!snapshot) return "expired";
  if (
    snapshot.ownerKey !== ownerKey ||
    snapshot.queryKey !== dashboardQueryKey(query) ||
    position >= snapshot.total
  ) {
    return "invalid";
  }
  return isDashboardSnapshotExpired(snapshot.expiresAt, now)
    ? "expired"
    : "ok";
}

export function dashboardQueryKey(query: DashboardQuery): string {
  return createHash("sha256").update(buildDashboardHref(query)).digest("hex");
}

export function buildDashboardSnapshotMembers(
  rows: readonly DashboardSnapshotSourceRow[]
): DashboardSnapshotMember[] {
  return rows.map((row, position) => ({
    position,
    showId: row.id,
    sortDate: row.date,
  }));
}

export function dashboardSnapshotExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + DASHBOARD_SNAPSHOT_TTL_MS);
}

export function isDashboardSnapshotExpired(
  expiresAt: Date,
  now: Date
): boolean {
  return expiresAt.getTime() <= now.getTime();
}

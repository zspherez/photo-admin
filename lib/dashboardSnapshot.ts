import { createHash, randomBytes } from "node:crypto";
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

export function dashboardQueryKey(query: DashboardQuery): string {
  return createHash("sha256").update(buildDashboardHref(query)).digest("hex");
}

export function createDashboardSnapshotCursorKey(): string {
  return randomBytes(32).toString("hex");
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

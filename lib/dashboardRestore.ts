export const MAX_DASHBOARD_RESTORE_BATCHES = 20;
const RESTORE_STATE_VERSION = 1;
const RESTORE_STATE_TTL_MS = 24 * 60 * 60 * 1000;

export interface DashboardRestoreState {
  v: number;
  batches: number;
  snapshotId: string;
  nextCursor: string | null;
  anchorId: string | null;
  anchorOffset: number;
  scrollY: number;
  savedAt: number;
}

function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function safeCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 1024 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function dashboardRestoreStorageKey(
  persistenceScope: string,
  queryHref: string
): string {
  if (
    !/^[0-9a-f]{64}$/.test(persistenceScope) ||
    !/^\/dashboard(?:\?|$)/.test(queryHref) ||
    queryHref.length > 512
  ) {
    throw new Error("Invalid dashboard persistence scope");
  }

  return `photo-admin:dashboard-depth:v1:${persistenceScope}:${encodeURIComponent(queryHref)}`;
}

export function dashboardRestoreIntentStorageKey(
  persistenceScope: string
): string {
  if (!/^[0-9a-f]{64}$/.test(persistenceScope)) {
    throw new Error("Invalid dashboard persistence scope");
  }

  return `photo-admin:dashboard-return-intent:v1:${persistenceScope}`;
}

export function hasDashboardRestoreIntent(
  storageKey: string,
  historyIntent: unknown,
  sessionIntent: string | null
): boolean {
  return historyIntent === storageKey || sessionIntent === storageKey;
}

export function parseDashboardRestoreState(
  value: string | null,
  now = Date.now()
): DashboardRestoreState | null {
  if (!value || value.length > 4096) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DashboardRestoreState>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !==
        "anchorId,anchorOffset,batches,nextCursor,savedAt,scrollY,snapshotId,v" ||
      parsed.v !== RESTORE_STATE_VERSION ||
      !Number.isSafeInteger(parsed.batches) ||
      (parsed.batches ?? 0) < 1 ||
      (parsed.batches ?? 0) > MAX_DASHBOARD_RESTORE_BATCHES ||
      !safeId(parsed.snapshotId) ||
      !(
        parsed.nextCursor === null ||
        safeCursor(parsed.nextCursor)
      ) ||
      !(parsed.anchorId === null || safeId(parsed.anchorId)) ||
      typeof parsed.anchorOffset !== "number" ||
      !Number.isFinite(parsed.anchorOffset) ||
      parsed.anchorOffset < -10_000 ||
      parsed.anchorOffset > 10_000 ||
      typeof parsed.scrollY !== "number" ||
      !Number.isFinite(parsed.scrollY) ||
      parsed.scrollY < 0 ||
      parsed.scrollY > 10_000_000 ||
      typeof parsed.savedAt !== "number" ||
      !Number.isSafeInteger(parsed.savedAt) ||
      parsed.savedAt > now + 5 * 60 * 1000 ||
      parsed.savedAt < now - RESTORE_STATE_TTL_MS
    ) {
      return null;
    }
    return parsed as DashboardRestoreState;
  } catch {
    return null;
  }
}

export function createDashboardRestoreState(input: {
  batches: number;
  snapshotId: string;
  nextCursor: string | null;
  anchorId: string | null;
  anchorOffset: number;
  scrollY: number;
  savedAt?: number;
}): DashboardRestoreState {
  const value = JSON.stringify({
    v: RESTORE_STATE_VERSION,
    ...input,
    savedAt: input.savedAt ?? Date.now(),
  });
  const parsed = parseDashboardRestoreState(
    value,
    input.savedAt ?? Date.now()
  );
  if (!parsed) throw new Error("Invalid dashboard restore state");
  return parsed;
}

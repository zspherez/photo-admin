import {
  buildDashboardHref,
  type DashboardQuery,
} from "@/lib/dashboardQuery";

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface DashboardCursor {
  date: Date;
  id: string;
  snapshotAt: Date;
}

interface DashboardCursorPayload {
  v: number;
  date: string;
  id: string;
  snapshotAt: string;
  scope: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (
    !value ||
    value.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1
  ) {
    return null;
  }
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    );
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function exactIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value
    ? date
    : null;
}

function isStoredCalendarDate(value: Date): boolean {
  return (
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  );
}

export function dashboardCursorScope(query: DashboardQuery): string {
  return buildDashboardHref(query);
}

export function encodeDashboardCursor(
  cursor: DashboardCursor,
  query: DashboardQuery
): string {
  if (
    !isStoredCalendarDate(cursor.date) ||
    !Number.isFinite(cursor.snapshotAt.getTime()) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(cursor.id)
  ) {
    throw new Error("Cannot encode an invalid dashboard cursor");
  }
  const payload: DashboardCursorPayload = {
    v: CURSOR_VERSION,
    date: cursor.date.toISOString(),
    id: cursor.id,
    snapshotAt: cursor.snapshotAt.toISOString(),
    scope: dashboardCursorScope(query),
  };
  return bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
}

export function decodeDashboardCursor(
  value: unknown,
  query: DashboardQuery,
  now = new Date()
): DashboardCursor | null {
  if (typeof value !== "string") return null;
  const bytes = base64UrlToBytes(value);
  if (!bytes) return null;

  try {
    const payload = JSON.parse(decoder.decode(bytes)) as Partial<DashboardCursorPayload>;
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).sort().join(",") !==
        "date,id,scope,snapshotAt,v" ||
      payload.v !== CURSOR_VERSION ||
      payload.scope !== dashboardCursorScope(query) ||
      typeof payload.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(payload.id)
    ) {
      return null;
    }
    const date = exactIsoDate(payload.date);
    const snapshotAt = exactIsoDate(payload.snapshotAt);
    if (
      !date ||
      !snapshotAt ||
      !isStoredCalendarDate(date) ||
      snapshotAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS
    ) {
      return null;
    }
    return { date, id: payload.id, snapshotAt };
  } catch {
    return null;
  }
}

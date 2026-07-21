import { createHmac, timingSafeEqual } from "node:crypto";
import {
  buildDashboardHref,
  type DashboardQuery,
} from "@/lib/dashboardQuery";

const CURSOR_VERSION = 2;
const MAX_CURSOR_LENGTH = 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface DashboardCursor {
  snapshotId: string;
  position: number;
  signature: string;
}

interface DashboardCursorPayload {
  v: number;
  snapshotId: string;
  position: number;
  scope: string;
  signature: string;
}

function signingInput(
  snapshotId: string,
  position: number,
  scope: string
): string {
  return `${CURSOR_VERSION}\u0000${snapshotId}\u0000${position}\u0000${scope}`;
}

function cursorSignature(
  snapshotId: string,
  position: number,
  scope: string,
  cursorKey: string
): string {
  return createHmac("sha256", cursorKey)
    .update(signingInput(snapshotId, position, scope))
    .digest("base64url");
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

export function dashboardCursorScope(query: DashboardQuery): string {
  return buildDashboardHref(query);
}

export function encodeDashboardCursor(
  cursor: Pick<DashboardCursor, "snapshotId" | "position">,
  query: DashboardQuery,
  cursorKey: string
): string {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(cursor.snapshotId) ||
    !Number.isSafeInteger(cursor.position) ||
    cursor.position < 0 ||
    !/^[0-9a-f]{64}$/.test(cursorKey)
  ) {
    throw new Error("Cannot encode an invalid dashboard cursor");
  }
  const payload: DashboardCursorPayload = {
    v: CURSOR_VERSION,
    snapshotId: cursor.snapshotId,
    position: cursor.position,
    scope: dashboardCursorScope(query),
    signature: cursorSignature(
      cursor.snapshotId,
      cursor.position,
      dashboardCursorScope(query),
      cursorKey
    ),
  };
  return bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
}

export function decodeDashboardCursor(
  value: unknown,
  query: DashboardQuery
): DashboardCursor | null {
  if (typeof value !== "string") return null;
  const bytes = base64UrlToBytes(value);
  if (!bytes) return null;

  try {
    const payload = JSON.parse(
      decoder.decode(bytes)
    ) as Partial<DashboardCursorPayload>;
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).sort().join(",") !==
        "position,scope,signature,snapshotId,v" ||
      payload.v !== CURSOR_VERSION ||
      payload.scope !== dashboardCursorScope(query) ||
      typeof payload.snapshotId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(payload.snapshotId) ||
      typeof payload.position !== "number" ||
      !Number.isSafeInteger(payload.position) ||
      payload.position < 0 ||
      typeof payload.signature !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.signature)
    ) {
      return null;
    }
    return {
      snapshotId: payload.snapshotId,
      position: payload.position,
      signature: payload.signature,
    };
  } catch {
    return null;
  }
}

export function verifyDashboardCursor(
  cursor: DashboardCursor,
  query: DashboardQuery,
  cursorKey: string
): boolean {
  if (!/^[0-9a-f]{64}$/.test(cursorKey)) return false;
  const expected = cursorSignature(
    cursor.snapshotId,
    cursor.position,
    dashboardCursorScope(query),
    cursorKey
  );
  const actualBytes = Buffer.from(cursor.signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

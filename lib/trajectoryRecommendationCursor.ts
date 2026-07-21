import { createHmac, timingSafeEqual } from "node:crypto";
import {
  buildRecommendationHref,
  type RecommendationQuery,
} from "@/lib/trajectoryRecommendationQuery";

const VERSION = 1;
const MAX_CURSOR_LENGTH = 1024;

interface CursorPayload {
  v: number;
  runId: string;
  offset: number;
  scope: string;
  signature: string;
}

export interface RecommendationCursor {
  runId: string;
  offset: number;
  signature: string;
}

function scope(query: RecommendationQuery): string {
  return buildRecommendationHref(query);
}

function signingInput(
  runId: string,
  offset: number,
  cursorScope: string,
): string {
  return `${VERSION}\u0000${runId}\u0000${offset}\u0000${cursorScope}`;
}

function signature(
  runId: string,
  offset: number,
  cursorScope: string,
  signingKey: string,
): string {
  return createHmac("sha256", signingKey)
    .update(signingInput(runId, offset, cursorScope))
    .digest("base64url");
}

export function encodeRecommendationCursor(
  runId: string,
  offset: number,
  query: RecommendationQuery,
  signingKey: string,
): string {
  if (
    !runId ||
    runId.length > 128 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !/^[0-9a-f]{64}$/.test(signingKey)
  ) {
    throw new Error("Cannot encode an invalid recommendation cursor");
  }
  const cursorScope = scope(query);
  const payload: CursorPayload = {
    v: VERSION,
    runId,
    offset,
    scope: cursorScope,
    signature: signature(runId, offset, cursorScope, signingKey),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeRecommendationCursor(
  value: unknown,
  query: RecommendationQuery,
): RecommendationCursor | null {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return null;
  }
  try {
    const canonical = Buffer.from(value, "base64url").toString("base64url");
    if (canonical !== value) return null;
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      Object.keys(payload).sort().join(",") !==
        "offset,runId,scope,signature,v" ||
      payload.v !== VERSION ||
      payload.scope !== scope(query) ||
      typeof payload.runId !== "string" ||
      !payload.runId ||
      payload.runId.length > 128 ||
      typeof payload.offset !== "number" ||
      !Number.isSafeInteger(payload.offset) ||
      payload.offset < 0 ||
      typeof payload.signature !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.signature)
    ) {
      return null;
    }
    return {
      runId: payload.runId,
      offset: payload.offset,
      signature: payload.signature,
    };
  } catch {
    return null;
  }
}

export function verifyRecommendationCursor(
  cursor: RecommendationCursor,
  query: RecommendationQuery,
  signingKey: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(signingKey)) return false;
  const expected = signature(
    cursor.runId,
    cursor.offset,
    scope(query),
    signingKey,
  );
  const actualBytes = Buffer.from(cursor.signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

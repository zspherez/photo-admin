import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncStatsfmTopArtistRanges } from "@/lib/statsfm";
import { syncSpotifyListens } from "@/lib/spotify";
import {
  getConfiguredSheetTarget,
  syncConfiguredContactsFromSheet,
} from "@/lib/sheets";
import { isValidCronAuthorization } from "@/lib/cron-auth";
import {
  runCronSource,
  type CronSourceResult,
} from "@/lib/cronResult";
import {
  assertOperationTimeRemaining,
  createOperationDeadline,
  PROVIDER_REQUEST_MIN_REMAINING_MS,
  ROUTE_DEADLINE_SAFETY_MARGIN_MS,
} from "@/lib/integrationUtils";

export const maxDuration = 300;

type MonitoredCronSourceResult<T> =
  | CronSourceResult<T>
  | {
      ok: false;
      durationMs: number;
      error: string;
      data: T;
    };

export function monitorRequiredSyncResult<T>(
  execution: CronSourceResult<T>
): MonitoredCronSourceResult<T> {
  if (!execution.ok) return execution;
  const data = execution.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "ok" in data &&
    data.ok === false
  ) {
    const status =
      "status" in data && typeof data.status === "string"
        ? data.status
        : "failed";
    const reason =
      "reason" in data && typeof data.reason === "string"
        ? data.reason
        : status;
    return {
      ok: false,
      durationMs: execution.durationMs,
      error: reason,
      data,
    };
  }
  return execution;
}

export function syncListensHttpStatus(
  results: readonly MonitoredCronSourceResult<unknown>[]
): 200 | 409 | 500 {
  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) return 200;
  const conflictsOnly = failures.every(
    (result) =>
      "data" in result &&
      typeof result.data === "object" &&
      result.data !== null &&
      "status" in result.data &&
      result.data.status === "busy"
  );
  return conflictsOnly ? 409 : 500;
}

export async function GET(request: NextRequest) {
  const deadline = createOperationDeadline(maxDuration * 1_000, {
    safetyMarginMs: ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  });
  if (!(await isValidCronAuthorization(request.headers.get("authorization")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const spotifyExecution = await runCronSource("sync-listens", "spotify", async () => {
    assertOperationTimeRemaining(
      deadline,
      PROVIDER_REQUEST_MIN_REMAINING_MS,
      "Spotify listen sync"
    );
    const credential = await db.integrationCredential.findUnique({
      where: { provider: "spotify" },
      select: { id: true },
    });
    if (!credential) return { skippedReason: "Spotify not connected" };
    return syncSpotifyListens(deadline);
  });
  const statsfmExecution = await runCronSource("sync-listens", "statsfm", async () => {
    assertOperationTimeRemaining(
      deadline,
      PROVIDER_REQUEST_MIN_REMAINING_MS,
      "Stats.fm listen sync"
    );
    const credential = await db.integrationCredential.findUnique({
      where: { provider: "statsfm" },
    });
    if (!credential?.meta) return { skippedReason: "Stats.fm not connected" };
    const metadata = JSON.parse(credential.meta) as { userId?: unknown };
    if (typeof metadata.userId !== "string" || !metadata.userId) {
      throw new Error("Stats.fm credential is missing a user id");
    }
    return syncStatsfmTopArtistRanges(metadata.userId, [
      { range: "lifetime", limit: 500 },
      { range: "months", limit: 200 },
      { range: "weeks", limit: 200 },
    ], deadline);
  });
  const sheetsExecution = await runCronSource("sync-listens", "sheets", async () => {
    assertOperationTimeRemaining(
      deadline,
      PROVIDER_REQUEST_MIN_REMAINING_MS,
      "Sheets contact sync"
    );
    const credentialsConfigured =
      Boolean(process.env.GOOGLE_CREDENTIALS_JSON) ||
      Boolean(process.env.GOOGLE_CREDENTIALS_PATH);
    if (!credentialsConfigured) {
      return { skippedReason: "Google Sheets credentials not configured" };
    }
    if (!(await getConfiguredSheetTarget())) {
      return { skippedReason: "Google Sheets target not configured" };
    }
    return syncConfiguredContactsFromSheet(deadline);
  });

  const spotify = monitorRequiredSyncResult(spotifyExecution);
  const statsfm = monitorRequiredSyncResult(statsfmExecution);
  const sheets = monitorRequiredSyncResult(sheetsExecution);
  const results = { spotify, statsfm, sheets };
  const status = syncListensHttpStatus(Object.values(results));
  return NextResponse.json(
    { ok: status === 200, results },
    { status }
  );
}

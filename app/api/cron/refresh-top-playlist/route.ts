import { NextRequest, NextResponse } from "next/server";
import {
  refreshTopTracksPlaylist,
  type TopPlaylistExecutionResult,
} from "@/lib/topPlaylist";
import { isValidCronAuthorization } from "@/lib/cron-auth";
import {
  runCronSource,
  type CronSourceResult,
} from "@/lib/cronResult";
import {
  createOperationDeadline,
  ROUTE_DEADLINE_SAFETY_MARGIN_MS,
} from "@/lib/integrationUtils";

export const maxDuration = 180;

type MonitoredTopPlaylistResult =
  | CronSourceResult<TopPlaylistExecutionResult>
  | {
      ok: false;
      durationMs: number;
      error: string;
      data: Exclude<TopPlaylistExecutionResult, { ok: true }>;
    };

export function monitorTopPlaylistResult(
  execution: CronSourceResult<TopPlaylistExecutionResult>
): MonitoredTopPlaylistResult {
  if (!execution.ok || execution.data.ok) return execution;
  return {
    ok: false,
    durationMs: execution.durationMs,
    error: execution.data.reason,
    data: execution.data,
  };
}

export function topPlaylistHttpStatus(
  result: MonitoredTopPlaylistResult
): 200 | 409 | 500 {
  if (result.ok) return 200;
  if (
    "data" in result &&
    (result.data.status === "busy" || result.data.status === "stale")
  ) {
    return 409;
  }
  return 500;
}

export async function GET(request: NextRequest) {
  const deadline = createOperationDeadline(maxDuration * 1_000, {
    safetyMarginMs: ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  });
  if (!(await isValidCronAuthorization(request.headers.get("authorization")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const playlist = monitorTopPlaylistResult(
    await runCronSource(
      "refresh-top-playlist",
      "spotify_playlist",
      () => refreshTopTracksPlaylist(50, deadline)
    )
  );
  const status = topPlaylistHttpStatus(playlist);
  return NextResponse.json(
    { ok: playlist.ok, results: { playlist } },
    { status }
  );
}

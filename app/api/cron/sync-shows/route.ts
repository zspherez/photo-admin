import { NextRequest, NextResponse } from "next/server";
import {
  syncAllEdmtrain,
  type EdmtrainSyncResult,
} from "@/lib/edmtrain";
import { isValidCronAuthorization } from "@/lib/cron-auth";
import { runCronSource } from "@/lib/cronResult";
import {
  createOperationDeadline,
  ROUTE_DEADLINE_SAFETY_MARGIN_MS,
} from "@/lib/integrationUtils";

export const maxDuration = 300;

export function edmtrainCompletion(result: EdmtrainSyncResult): {
  ok: boolean;
  status: 200 | 409 | 500;
} {
  const scopes = [result.nyc, result.festivals];
  const failures = scopes.filter((scope) => !scope.ok);
  if (failures.length === 0) return { ok: true, status: 200 };
  const conflictsOnly = failures.every(
    (scope) => "status" in scope && scope.status === "busy"
  );
  return { ok: false, status: conflictsOnly ? 409 : 500 };
}

export async function GET(request: NextRequest) {
  const deadline = createOperationDeadline(maxDuration * 1_000, {
    safetyMarginMs: ROUTE_DEADLINE_SAFETY_MARGIN_MS,
  });
  if (!(await isValidCronAuthorization(request.headers.get("authorization")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const execution = await runCronSource("sync-shows", "edmtrain", () =>
    syncAllEdmtrain(90, 365, deadline)
  );
  if (!execution.ok) {
    return NextResponse.json(
      { ok: false, results: { edmtrain: execution } },
      { status: 500 }
    );
  }

  const completion = edmtrainCompletion(execution.data);
  const edmtrain = {
    ok: completion.ok,
    durationMs: execution.durationMs,
    ...execution.data,
  };
  return NextResponse.json(
    { ok: completion.ok, results: { edmtrain } },
    { status: completion.status }
  );
}

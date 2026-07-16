import { NextRequest, NextResponse } from "next/server";
import { isValidCronAuthorization } from "@/lib/cron-auth";
import { db } from "@/lib/db";
import { dispatchScheduledOutreach } from "@/lib/sendOutreach";
import {
  getScheduledDispatchDisposition,
  getScheduledDispatchHttpStatus,
  getScheduledDispatchState,
  OUTREACH_CLAIM_TIMEOUT_MS,
  SCHEDULED_DISPATCH_MAX_ROWS,
  type ScheduledDispatchDisposition,
  shouldContinueScheduledDispatch,
} from "@/lib/schedule";

export const maxDuration = 60;

// Invoked by the deployment scheduler. Drains due outreach in oldest-first
// order while keeping each invocation bounded.
export async function GET(request: NextRequest) {
  if (!(await isValidCronAuthorization(request.headers.get("authorization")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const results: {
    id: string;
    ok: boolean;
    disposition: ScheduledDispatchDisposition;
    skipped?: boolean;
    retryScheduled?: boolean;
    nextAttemptAt?: Date;
    warnings?: string[];
    rateCardAttachmentOmitted?: boolean;
    error?: string;
  }[] = [];

  while (shouldContinueScheduledDispatch(startedAt, results.length)) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - OUTREACH_CLAIM_TIMEOUT_MS);
    let due: { id: string }[];
    try {
      due = await db.outreach.findMany({
        where: {
          nextAttemptAt: { lte: now },
          OR: [
            { status: "scheduled" },
            { status: "retry_scheduled" },
            {
              status: "queued",
              OR: [{ claimedAt: null }, { claimedAt: { lte: staleBefore } }],
            },
          ],
        },
        select: { id: true },
        orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: Math.min(10, SCHEDULED_DISPATCH_MAX_ROWS - results.length),
      });
    } catch (error) {
      results.push({
        id: "dispatcher",
        ok: false,
        disposition: "retryable",
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
    if (due.length === 0) break;

    for (const row of due) {
      if (!shouldContinueScheduledDispatch(startedAt, results.length)) break;
      try {
        const result = await dispatchScheduledOutreach(row.id);
        results.push({
          id: row.id,
          ok: result.ok,
          disposition: getScheduledDispatchDisposition(result),
          skipped: result.skipped || undefined,
          retryScheduled: result.retryScheduled || undefined,
          nextAttemptAt: result.nextAttemptAt,
          warnings: result.warnings,
          rateCardAttachmentOmitted:
            result.rateCardAttachmentOmitted || undefined,
          error: result.error,
        });
      } catch (error) {
        results.push({
          id: row.id,
          ok: false,
          disposition: "retryable",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  let scheduledRetries = 0;
  let nextRetryAt: Date | null = null;
  let pendingClaims = 0;
  let nextClaimExpiryAt: Date | null = null;
  try {
    const summaryNow = new Date();
    const staleBefore = new Date(
      summaryNow.getTime() - OUTREACH_CLAIM_TIMEOUT_MS,
    );
    const [retrySummary, claimSummary] = await Promise.all([
      db.outreach.aggregate({
        where: {
          status: "retry_scheduled",
          nextAttemptAt: { not: null },
        },
        _count: { _all: true },
        _min: { nextAttemptAt: true },
      }),
      db.outreach.aggregate({
        where: {
          status: "queued",
          claimedAt: { gt: staleBefore },
          nextAttemptAt: { not: null },
        },
        _count: { _all: true },
        _min: { claimedAt: true },
      }),
    ]);
    scheduledRetries = retrySummary._count._all;
    nextRetryAt = retrySummary._min.nextAttemptAt;
    pendingClaims = claimSummary._count._all;
    nextClaimExpiryAt = claimSummary._min.claimedAt
      ? new Date(
          claimSummary._min.claimedAt.getTime() + OUTREACH_CLAIM_TIMEOUT_MS,
        )
      : null;
  } catch (error) {
    results.push({
      id: "dispatcher-summary",
      ok: false,
      disposition: "retryable",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const terminalFailures = results.filter(
    (result) => result.disposition === "terminal",
  ).length;
  const retryableFailures = results.filter(
    (result) => result.disposition === "retryable",
  ).length;
  const unscheduledRetryableFailures = results.filter(
    (result) =>
      result.disposition === "retryable" && !result.retryScheduled,
  ).length;
  const bounded = !shouldContinueScheduledDispatch(
    startedAt,
    results.length,
  );
  const state = getScheduledDispatchState({
    terminalFailures,
    unscheduledRetryableFailures,
    pendingClaims,
    scheduledRetries,
    bounded,
  });
  return NextResponse.json(
    {
      ok:
        state !== "terminal_failure" &&
        state !== "retryable_failure",
      complete: state === "complete",
      state,
      dispatched: results.filter(
        (result) => result.disposition === "success",
      ).length,
      skipped: results.filter(
        (result) => result.disposition === "skipped",
      ).length,
      retriesScheduled: results.filter((result) => result.retryScheduled).length,
      scheduledRetries,
      nextRetryAt,
      pendingClaims,
      nextClaimExpiryAt,
      failures: terminalFailures,
      terminalFailures,
      retryableFailures,
      unscheduledRetryableFailures,
      bounded,
      results,
    },
    {
      status: getScheduledDispatchHttpStatus(state),
    },
  );
}

import { NextRequest, NextResponse } from "next/server";
import { isValidCronAuthorization } from "@/lib/cron-auth";
import { db } from "@/lib/db";
import { dispatchScheduledOutreach } from "@/lib/sendOutreach";
import { dispatchScheduledArbitraryEmail } from "@/lib/sendArbitraryEmail";
import {
  getScheduledDispatchDisposition,
  getScheduledDispatchHttpStatus,
  getScheduledDispatchState,
  getOutreachRecoveryCutoff,
  isOutreachMorningDispatchWindow,
  OUTREACH_CLAIM_TIMEOUT_MS,
  SCHEDULED_DISPATCH_MAX_ROWS,
  type ScheduledDispatchDisposition,
  shouldContinueScheduledDispatch,
} from "@/lib/schedule";

export const maxDuration = 60;

type DispatchMode = "morning" | "recovery" | "manual";

function scheduledDispatchMode(request: NextRequest): DispatchMode | null {
  const mode = request.nextUrl.searchParams.get("mode") ?? "manual";
  return mode === "morning" || mode === "recovery" || mode === "manual"
    ? mode
    : null;
}

// Invoked by the deployment scheduler. Drains due outreach in oldest-first
// order while keeping each invocation bounded.
export async function GET(request: NextRequest) {
  if (!(await isValidCronAuthorization(request.headers.get("authorization")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const mode = scheduledDispatchMode(request);
  if (!mode) {
    return NextResponse.json({ error: "invalid dispatch mode" }, { status: 400 });
  }
  if (mode === "morning" && !isOutreachMorningDispatchWindow()) {
    return NextResponse.json({
      ok: true,
      complete: true,
      state: "complete",
      mode,
      outsideMorningWindow: true,
      dispatched: 0,
      skipped: 0,
      retriesScheduled: 0,
      scheduledRetries: 0,
      nextRetryAt: null,
      pendingClaims: 0,
      nextClaimExpiryAt: null,
      failures: 0,
      terminalFailures: 0,
      retryableFailures: 0,
      unscheduledRetryableFailures: 0,
      bounded: false,
      results: [],
    });
  }

  const startedAt = Date.now();
  const results: {
    id: string;
    kind?: "outreach" | "arbitrary_email";
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
    const recoveryCutoff = getOutreachRecoveryCutoff(now);
    let due: {
      id: string;
      kind: "outreach" | "arbitrary_email";
      nextAttemptAt: Date | null;
      createdAt: Date;
    }[];
    try {
      const [outreachDue, arbitraryDue] = await Promise.all([
        db.outreach.findMany({
          where: {
            OR: [
              {
                status: "scheduled",
                nextAttemptAt: {
                  lte: mode === "recovery" ? recoveryCutoff : now,
                },
              },
              {
                status: "retry_scheduled",
                nextAttemptAt: { lte: now },
              },
              {
                status: "queued",
                nextAttemptAt: { lte: now },
                OR: [{ claimedAt: null }, { claimedAt: { lte: staleBefore } }],
              },
            ],
          },
          select: { id: true, nextAttemptAt: true, createdAt: true },
          orderBy: [
            { nextAttemptAt: "asc" },
            { createdAt: "asc" },
            { id: "asc" },
          ],
          take: Math.min(10, SCHEDULED_DISPATCH_MAX_ROWS - results.length),
        }),
        db.arbitraryEmail.findMany({
          where: {
            OR: [
              {
                status: "scheduled",
                nextAttemptAt: {
                  lte: mode === "recovery" ? recoveryCutoff : now,
                },
              },
              {
                status: "retry_scheduled",
                nextAttemptAt: { lte: now },
              },
              {
                status: "queued",
                nextAttemptAt: { lte: now },
                claimedAt: { lte: staleBefore },
              },
              {
                status: "sending",
                nextAttemptAt: { lte: now },
                claimedAt: { lte: staleBefore },
              },
            ],
          },
          select: { id: true, nextAttemptAt: true, createdAt: true },
          orderBy: [
            { nextAttemptAt: "asc" },
            { createdAt: "asc" },
            { id: "asc" },
          ],
          take: Math.min(10, SCHEDULED_DISPATCH_MAX_ROWS - results.length),
        }),
      ]);
      due = [
        ...outreachDue.map((row) => ({ ...row, kind: "outreach" as const })),
        ...arbitraryDue.map((row) => ({
          ...row,
          kind: "arbitrary_email" as const,
        })),
      ]
        .sort(
          (left, right) =>
            (left.nextAttemptAt?.getTime() ?? 0) -
              (right.nextAttemptAt?.getTime() ?? 0) ||
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        )
        .slice(0, Math.min(10, SCHEDULED_DISPATCH_MAX_ROWS - results.length));
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
        const result =
          row.kind === "outreach"
            ? await dispatchScheduledOutreach(row.id)
            : await dispatchScheduledArbitraryEmail(row.id);
        results.push({
          id: row.id,
          kind: row.kind,
          ok: result.ok,
          disposition: getScheduledDispatchDisposition(result),
          skipped: result.skipped || undefined,
          retryScheduled: result.retryScheduled || undefined,
          nextAttemptAt: result.nextAttemptAt,
          warnings: "warnings" in result ? result.warnings : undefined,
          rateCardAttachmentOmitted:
            ("rateCardAttachmentOmitted" in result &&
              result.rateCardAttachmentOmitted) ||
            undefined,
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
    const [
      outreachRetrySummary,
      outreachClaimSummary,
      arbitraryRetrySummary,
      arbitraryClaimSummary,
    ] = await Promise.all([
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
      db.arbitraryEmail.aggregate({
        where: {
          status: "retry_scheduled",
          nextAttemptAt: { not: null },
        },
        _count: { _all: true },
        _min: { nextAttemptAt: true },
      }),
      db.arbitraryEmail.aggregate({
        where: {
          status: "queued",
          claimedAt: { gt: staleBefore },
          nextAttemptAt: { not: null },
        },
        _count: { _all: true },
        _min: { claimedAt: true },
      }),
    ]);
    scheduledRetries =
      outreachRetrySummary._count._all + arbitraryRetrySummary._count._all;
    nextRetryAt = [
      outreachRetrySummary._min.nextAttemptAt,
      arbitraryRetrySummary._min.nextAttemptAt,
    ]
      .filter((value): value is Date => value !== null)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
    pendingClaims =
      outreachClaimSummary._count._all + arbitraryClaimSummary._count._all;
    const earliestClaimAt = [
      outreachClaimSummary._min.claimedAt,
      arbitraryClaimSummary._min.claimedAt,
    ]
      .filter((value): value is Date => value !== null)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
    nextClaimExpiryAt = earliestClaimAt
      ? new Date(
          earliestClaimAt.getTime() + OUTREACH_CLAIM_TIMEOUT_MS,
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
      mode,
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

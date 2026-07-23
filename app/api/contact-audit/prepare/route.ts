import { NextRequest, NextResponse } from "next/server";
import {
  ContactAuditValidationError,
  getTrustedContactAuditOidcEvent,
  isValidContactAuditAuthorization,
  noteContactAuditPrepareFailure,
  prepareContactAudit,
  requestMonthlyContactAudit,
  requestRollingMonthlyContactAudit,
} from "@/lib/contactAudit";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (
    !(await isValidContactAuditAuthorization(authorization))
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let workflowRunId: unknown;
  let requestFullAudit = false;
  let requestSource:
    | "manual"
    | "monthly"
    | "rolling_monthly"
    | "poll" = "poll";
  try {
    const value = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return NextResponse.json({ error: "invalid request body" }, { status: 400 });
    }
    workflowRunId = Reflect.get(value, "workflowRunId");
    const requested = Reflect.get(value, "requestFullAudit");
    if (requested !== undefined && typeof requested !== "boolean") {
      return NextResponse.json(
        { error: "requestFullAudit must be a boolean" },
        { status: 400 },
      );
    }
    requestFullAudit = requested ?? false;
    const source = Reflect.get(value, "requestSource");
    if (
      source !== undefined &&
      source !== "manual" &&
      source !== "monthly" &&
      source !== "rolling_monthly" &&
      source !== "poll"
    ) {
      return NextResponse.json(
        {
          error:
            "requestSource must be manual, monthly, rolling_monthly, or poll",
        },
        { status: 400 },
      );
    }
    requestSource = source ?? "poll";
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const oidcEvent = requestFullAudit
      ? await getTrustedContactAuditOidcEvent(authorization)
      : null;
    if (
      requestFullAudit &&
      !(
        (requestSource === "manual" && oidcEvent === "workflow_dispatch") ||
        ((requestSource === "monthly" ||
          requestSource === "rolling_monthly") &&
          oidcEvent === "schedule")
      )
    ) {
      return NextResponse.json(
        {
          error:
            "full audit requests require a manual dispatch or monthly schedule",
        },
        { status: 403 },
      );
    }
    if (requestSource === "monthly") {
      const monthlyRequest = await requestMonthlyContactAudit();
      return NextResponse.json({
        requested: true,
        queued: true,
        created: monthlyRequest.created,
        requestId: monthlyRequest.id,
        runId: monthlyRequest.runId,
        resumed: false,
        contactCount: 0,
        claimable: 0,
      });
    }
    if (requestSource === "rolling_monthly") {
      const rollingRequest = await requestRollingMonthlyContactAudit();
      return NextResponse.json({
        requested: true,
        queued: true,
        created: rollingRequest.created,
        requestId: rollingRequest.id,
        runId: rollingRequest.runId,
        resumed: false,
        contactCount: 0,
        claimable: 0,
      });
    }
    return NextResponse.json(
      await prepareContactAudit(workflowRunId, new Date(), {
        requestIfMissing: requestFullAudit,
      }),
    );
  } catch (error) {
    if (error instanceof ContactAuditValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    await noteContactAuditPrepareFailure(workflowRunId, error).catch(() => {});
    console.error(
      JSON.stringify({
        event: "contact_audit_prepare_failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return NextResponse.json(
      { error: "unable to prepare contact audit" },
      { status: 500 }
    );
  }
}

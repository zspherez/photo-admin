import { NextRequest, NextResponse } from "next/server";
import {
  ContactAuditValidationError,
  getTrustedContactAuditOidcEvent,
  isValidContactAuditAuthorization,
  noteContactAuditPrepareFailure,
  prepareContactAudit,
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
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    if (
      requestFullAudit &&
      (await getTrustedContactAuditOidcEvent(authorization)) !==
        "workflow_dispatch"
    ) {
      return NextResponse.json(
        { error: "full audit requests require a manual workflow dispatch" },
        { status: 403 },
      );
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

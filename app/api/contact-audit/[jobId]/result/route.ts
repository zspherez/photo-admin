import { NextRequest, NextResponse } from "next/server";
import {
  ContactAuditValidationError,
  isValidContactAuditAuthorization,
  submitContactAuditResult,
} from "@/lib/contactAudit";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  if (
    !(await isValidContactAuditAuthorization(
      request.headers.get("authorization")
    ))
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { jobId } = await context.params;
  if (!jobId.trim()) {
    return NextResponse.json({ error: "missing job id" }, { status: 400 });
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const result = await submitContactAuditResult(jobId, value);
    if (!result.accepted) {
      return NextResponse.json(
        { error: "claim is stale or no longer owned" },
        { status: 409 }
      );
    }
    return NextResponse.json({
      ok: true,
      runComplete: result.runComplete,
      autoResolved: result.autoResolved,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ContactAuditValidationError) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error(
      JSON.stringify({
        event: "contact_audit_submission_failed",
        jobId,
        error: message,
      })
    );
    return NextResponse.json(
      { error: "unable to save contact audit result" },
      { status: 500 }
    );
  }
}

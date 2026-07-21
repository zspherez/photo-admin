import { NextRequest, NextResponse } from "next/server";
import {
  ContactAuditValidationError,
  isValidContactAuditAuthorization,
  recordContactAuditWorkflowFailure,
} from "@/lib/contactAudit";

export async function POST(request: NextRequest) {
  if (
    !(await isValidContactAuditAuthorization(
      request.headers.get("authorization")
    ))
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  try {
    const accepted = await recordContactAuditWorkflowFailure(
      Reflect.get(value, "runId"),
      Reflect.get(value, "workflowRunId"),
      Reflect.get(value, "error")
    );
    return NextResponse.json({ ok: true, accepted });
  } catch (error) {
    if (error instanceof ContactAuditValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(
      JSON.stringify({
        event: "contact_audit_attempt_failure_record_failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return NextResponse.json(
      { error: "unable to record contact audit workflow failure" },
      { status: 500 }
    );
  }
}

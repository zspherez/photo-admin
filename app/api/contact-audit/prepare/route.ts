import { NextRequest, NextResponse } from "next/server";
import {
  isValidContactAuditAuthorization,
  prepareContactAudit,
} from "@/lib/contactAudit";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (
    !(await isValidContactAuditAuthorization(
      request.headers.get("authorization")
    ))
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await prepareContactAudit());
  } catch (error) {
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

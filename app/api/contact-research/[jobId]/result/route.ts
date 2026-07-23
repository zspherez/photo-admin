import { NextRequest, NextResponse } from "next/server";
import {
  isValidContactResearchAuthorization,
  parseContactResearchSubmission,
  submitContactResearchResult,
} from "@/lib/contactResearch";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  if (
    !(await isValidContactResearchAuthorization(
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

  let submission;
  try {
    submission = parseContactResearchSubmission(value);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }

  try {
    const result = await submitContactResearchResult(jobId, submission);
    if (!result.accepted) {
      if (result.status === "invalid_rule_provenance") {
        return NextResponse.json(
          {
            error:
              "agent rule provenance does not match the trusted claim snapshot",
          },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { error: "claim is stale or no longer owned" },
        { status: 409 }
      );
    }
    return NextResponse.json({
      ok: true,
      status: result.status,
      autoApproved: result.autoApproved,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "contact_research_submission_failed",
        jobId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return NextResponse.json(
      { error: "unable to save contact research result to the database" },
      { status: 500 }
    );
  }
}

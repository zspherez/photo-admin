import { NextRequest, NextResponse } from "next/server";
import {
  isValidProfessionalContactAuthorization,
  parseProfessionalContactSubmission,
  submitProfessionalContactResult,
} from "@/lib/professionalContactResearch";

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/professional-contact-research/[jobId]/result">,
) {
  if (
    !(await isValidProfessionalContactAuthorization(
      request.headers.get("authorization"),
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
    parseProfessionalContactSubmission(value);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  try {
    const result = await submitProfessionalContactResult(jobId, value);
    if (!result.accepted) {
      if (result.status === "duplicate_candidates") {
        return NextResponse.json(
          {
            error:
              "all submitted candidates already exist; revise the result or submit exhaustion",
            code: "duplicate_candidates",
          },
          { status: 422 },
        );
      }
      return NextResponse.json(
        {
          error: "claim is stale or no longer owned",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      status: result.status,
      idempotent: result.idempotent,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /does not match the claimed|evidence|candidate email|domain-pattern|broker provenance|broker-fetched|business domain|published organization email pattern|sourceUrls|patternExamples|public or disposable|generic or role inbox/.test(
        error.message,
      )
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(
      JSON.stringify({
        event: "professional_contact_submission_failed",
        jobId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { error: "unable to save professional contact research result" },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  claimProfessionalContactJobs,
  isValidProfessionalContactAuthorization,
  parseProfessionalContactClaimLimit,
} from "@/lib/professionalContactResearch";

export async function POST(request: NextRequest) {
  if (
    !(await isValidProfessionalContactAuthorization(
      request.headers.get("authorization"),
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "limit")) {
    return NextResponse.json(
      { error: "request body contains unsupported fields" },
      { status: 400 },
    );
  }
  let limit: number;
  try {
    limit = parseProfessionalContactClaimLimit(input.limit);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({
      jobs: await claimProfessionalContactJobs(limit),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "professional_contact_claim_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { error: "unable to claim professional contact research jobs" },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  countClaimableProfessionalContactJobs,
  isValidProfessionalContactAuthorization,
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
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 0
  ) {
    return NextResponse.json(
      { error: "request body must be an empty object" },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({
      claimable: await countClaimableProfessionalContactJobs(),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "professional_contact_prepare_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { error: "unable to prepare professional contact research" },
      { status: 500 },
    );
  }
}

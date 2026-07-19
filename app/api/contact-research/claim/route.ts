import { NextRequest, NextResponse } from "next/server";
import {
  claimContactResearchJobs,
  isValidContactResearchAuthorization,
  parseContactResearchClaimLimit,
} from "@/lib/contactResearch";

export async function POST(request: NextRequest) {
  if (
    !(await isValidContactResearchAuthorization(
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

  let limit: number;
  try {
    const body =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    limit = parseContactResearchClaimLimit(body.limit);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }

  try {
    const jobs = await claimContactResearchJobs(limit);
    return NextResponse.json({ jobs });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "contact_research_claim_failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return NextResponse.json(
      { error: "unable to claim contact research jobs" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  isValidContactResearchAuthorization,
  prepareContactResearchQueue,
} from "@/lib/contactResearch";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (
    !(await isValidContactResearchAuthorization(
      request.headers.get("authorization")
    ))
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await prepareContactResearchQueue());
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "contact_research_prepare_failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return NextResponse.json(
      { error: "unable to prepare contact research queue" },
      { status: 500 }
    );
  }
}

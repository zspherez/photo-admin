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

  let refreshQueue = false;
  try {
    const value = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return NextResponse.json({ error: "invalid request body" }, { status: 400 });
    }
    const requested = Reflect.get(value, "refreshQueue");
    if (typeof requested !== "boolean") {
      return NextResponse.json(
        { error: "refreshQueue must be a boolean" },
        { status: 400 },
      );
    }
    refreshQueue = requested;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    return NextResponse.json(
      await prepareContactResearchQueue(new Date(), { refreshQueue }),
    );
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

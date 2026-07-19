import { NextRequest, NextResponse } from "next/server";
import { isValidCronAuthorization } from "@/lib/cron-auth";
import { runCronSource } from "@/lib/cronResult";
import { refreshContactResearchQueue } from "@/lib/contactResearch";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!(await isValidCronAuthorization(request.headers.get("authorization")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const execution = await runCronSource(
    "contact-research",
    "queue",
    () => refreshContactResearchQueue()
  );
  return NextResponse.json(
    {
      ok: execution.ok,
      results: { queue: execution },
    },
    { status: execution.ok ? 200 : 500 }
  );
}
